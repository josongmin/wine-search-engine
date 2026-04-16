import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentTerminationReason, AgentToolCallPair } from '../../domain/agent/model/agent-step.js';
import type { ToolCallEvidenceFrame } from '../../domain/agent/model/tool-call-evidence-frame.js';
import { toolCallIdForStep } from '../../domain/agent/service/build-tool-call-evidence-frame.js';
import type { StepBudget } from '../../domain/agent/service/step-budget.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { PlannerPhaseResult } from './agent-planner-phase-runner.js';
import type { AgentToolDeps, AgentToolResult } from './agent-tools.js';
import {
  executeAgentTool,
  executeAgentToolsBatch,
  isKnownTool,
} from './agent-tools.js';
import { truncateObservation } from './agent-prompt.js';
import { evaluateBatchPolicy } from './tool-batch-policy.js';
import { AgentContractPolicy } from './agent-contract-policy.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import { AgentToolExecutionPolicy } from './agent-tool-execution-policy.js';
import {
  buildToolOutcome,
  getParallelBatchTimeoutMs,
  getToolTimeoutMs,
  MAX_TOOLS_PER_BATCH,
  withTimeout,
} from './agent-tool-execution-support.js';
import { AgentToolExecutionResultPolicy } from './agent-tool-execution-result-policy.js';

const log = bootstrapLogger.child({ component: 'AgentToolExecutionPhase' });

interface AgentToolExecutionPhaseDeps {
  readonly toolDeps: AgentToolDeps;
  readonly contractExecutionPhase: {
    runDrinkabilityChecks: (
      queryExecutionContract: AgentQueryExecutionContract,
      requestId: string,
      effectiveConfig: AgentConfig,
      budget: StepBudget,
      state: AgentExecutionState,
      abortSignal?: AbortSignal,
    ) => Promise<boolean>;
  };
}

export class AgentToolExecutionPhase {
  private readonly policy = new AgentToolExecutionPolicy();
  private readonly contractPolicy = new AgentContractPolicy();
  private readonly resultPolicy = new AgentToolExecutionResultPolicy();

  constructor(private readonly deps: AgentToolExecutionPhaseDeps) {}

  async run(
    requestId: string,
    effectiveConfig: AgentConfig,
    budget: StepBudget,
    state: AgentExecutionState,
    queryExecutionContract: AgentQueryExecutionContract,
    plannerPhase: PlannerPhaseResult,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const { stepStartMs, parsed, inputTokens, outputTokens } = plannerPhase;
    const pendingDrinkabilityEntityIds = this.contractPolicy.getPendingDrinkabilityEntityIds(
      queryExecutionContract,
      state,
    );

    if (typeof parsed.answer === 'string') {
      const trimmedAnswer = parsed.answer.trim();
      if (trimmedAnswer.length > 0) {
        if (pendingDrinkabilityEntityIds.length > 0) {
          state.pendingPlannerDirective = this.contractPolicy.buildPendingDrinkabilityDirective(pendingDrinkabilityEntityIds);
          return false;
        }
        state.steps.push({
          index: state.steps.length,
          thought: parsed.thought,
          answer: trimmedAnswer,
          durationMs: Math.max(0, Date.now() - stepStartMs),
          tokenCount: { input: inputTokens, output: outputTokens },
        });
        state.answer = trimmedAnswer;
        state.terminationReason = 'answer';
        return true;
      }
    }

    if (parsed.actions !== undefined) {
      return await this.runParallelBatch(
        requestId,
        effectiveConfig,
        budget,
        state,
        queryExecutionContract,
        pendingDrinkabilityEntityIds,
        plannerPhase,
        abortSignal,
      );
    }

    if (parsed.action !== undefined) {
      return await this.runSingleTool(
        requestId,
        effectiveConfig,
        budget,
        state,
        queryExecutionContract,
        pendingDrinkabilityEntityIds,
        plannerPhase,
        abortSignal,
      );
    }

    return false;
  }

  private async runParallelBatch(
    requestId: string,
    effectiveConfig: AgentConfig,
    budget: StepBudget,
    state: AgentExecutionState,
    queryExecutionContract: AgentQueryExecutionContract,
    pendingDrinkabilityEntityIds: readonly string[],
    plannerPhase: PlannerPhaseResult,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const { stepStartMs, parsed, inputTokens, outputTokens } = plannerPhase;
    const batchCalls = parsed.actions ?? [];
    const batchStepIndex = state.steps.length;
    const batchDurationMs = Math.max(0, Date.now() - stepStartMs);

    const pendingBatchViolation = this.contractPolicy.validateDrinkabilityBatch(
      pendingDrinkabilityEntityIds,
      batchCalls,
    );
    if (pendingBatchViolation !== null) {
      this.resultPolicy.recordBatchStep({
        requestId,
        stepIndex: batchStepIndex,
        thought: parsed.thought,
        calls: batchCalls,
        observation: pendingBatchViolation,
        durationMs: batchDurationMs,
        state,
        inputTokens,
        outputTokens,
        execError: false,
        timedOut: false,
        policyViolation: true,
      });
      return false;
    }

    if (batchCalls.length > MAX_TOOLS_PER_BATCH) {
      state.reasoningFailureDetected = true;
      state.terminationReason = 'error';
      const truncatedActions = batchCalls.slice(0, MAX_TOOLS_PER_BATCH);
      const batchErrorMsg = `Batch too large: ${batchCalls.length} tools requested (max ${MAX_TOOLS_PER_BATCH}). Retry with fewer parallel calls.`;
      this.resultPolicy.recordBatchStep({
        requestId,
        stepIndex: batchStepIndex,
        thought: parsed.thought,
        calls: truncatedActions,
        observation: batchErrorMsg,
        durationMs: batchDurationMs,
        inputTokens,
        outputTokens,
        state,
        execError: false,
        timedOut: false,
        policyViolation: true,
      });
      return true;
    }

    const unknownTool = batchCalls.find((c) => !isKnownTool(c.tool));
    if (unknownTool !== undefined) {
      state.reasoningFailureDetected = true;
      state.unknownToolAttempts++;
      if (state.unknownToolAttempts > 2) {
        state.terminationReason = 'error';
        return true;
      }
      const unknownToolMsg = `Unknown tool: ${unknownTool.tool}. Available: search_wines, compare_wines, check_drinking_window, get_food_pairings`;
      this.resultPolicy.recordBatchStep({
        requestId,
        stepIndex: batchStepIndex,
        thought: parsed.thought,
        calls: batchCalls,
        observation: unknownToolMsg,
        durationMs: batchDurationMs,
        inputTokens,
        outputTokens,
        state,
        execError: false,
        timedOut: false,
        policyViolation: true,
      });
      return false;
    }

    const effectiveBatchCalls = this.policy.resolveParallelBatch({
      calls: batchCalls,
      queryExecutionContract,
    });

    const batchPolicy = evaluateBatchPolicy(effectiveBatchCalls);
    if (!batchPolicy.allowed) {
      const policyReason = 'reason' in batchPolicy ? batchPolicy.reason : 'invalid_parallel_batch';
      const policyMsg = `Invalid parallel batch: ${policyReason}. Allowed: search_wines+search_wines/get_food_pairings, or check_drinking_window-only batches, or compare_wines alone.`;
      this.resultPolicy.recordBatchStep({
        requestId,
        stepIndex: batchStepIndex,
        thought: parsed.thought,
        calls: effectiveBatchCalls,
        observation: policyMsg,
        durationMs: batchDurationMs,
        inputTokens,
        outputTokens,
        state,
        execError: false,
        timedOut: false,
        policyViolation: true,
      });
      return false;
    }

    const batchCheck = budget.recordParallelBatch(effectiveBatchCalls, { skipNearDuplicate: true });
    if (!batchCheck.allowed) {
      const batchReason = (batchCheck as { readonly reason?: string }).reason;
      state.terminationReason = (batchReason as AgentTerminationReason | undefined) ?? 'loop_detected';
      return true;
    }

    let batchResults: readonly AgentToolResult[];
    const batchAbortController = new AbortController();
    const propagateBatchAbort = (): void => { batchAbortController.abort(); };
    abortSignal?.addEventListener('abort', propagateBatchAbort, { once: true });
    try {
      batchResults = await withTimeout(
        executeAgentToolsBatch(
          effectiveBatchCalls,
          this.deps.toolDeps,
          `${requestId}-step${state.steps.length}`,
          {
            abortSignal: batchAbortController.signal,
            toolCallId: toolCallIdForStep(requestId, state.steps.length),
          },
        ),
        getParallelBatchTimeoutMs(effectiveBatchCalls, effectiveConfig.parallelBatchTimeoutMs),
        'Parallel tool batch timed out',
      );
    } catch (batchErr) {
      batchAbortController.abort();
      const handled = this.resultPolicy.applyBatchExecutionFailure({
        err: batchErr,
        requestId,
        stepIndex: state.steps.length,
        thought: parsed.thought,
        calls: effectiveBatchCalls,
        durationMs: Math.max(0, Date.now() - stepStartMs),
        inputTokens,
        outputTokens,
        state,
      });
      if (!handled) {
        log.error({ err: batchErr, requestId, stepIndex: batchStepIndex }, 'parallel tool batch failed');
      }
      return true;
    } finally {
      abortSignal?.removeEventListener('abort', propagateBatchAbort);
    }

    const batchPairs: AgentToolCallPair[] = [];
    const observations: string[] = [];
    const batchFrames: ToolCallEvidenceFrame[] = [];
    for (let bi = 0; bi < batchResults.length; bi++) {
      const result = batchResults[bi]!;
      const call = effectiveBatchCalls[bi]!;
      const obs = truncateObservation(result.observation, effectiveConfig.maxContextChars);
      observations.push(obs);
      batchPairs.push({ action: call, observation: obs });
      if (
        result.rawResult !== null &&
        typeof result.rawResult === 'object' &&
        'queryType' in (result.rawResult as Record<string, unknown>) &&
        (result.rawResult as Record<string, unknown>)['queryType'] === 'search'
      ) {
        state.lastSearchResult = result.rawResult as SearchResponseV1;
      }
      if (result.evidenceFrame !== undefined) {
        batchFrames.push(result.evidenceFrame);
        state.collectedFrames.push(result.evidenceFrame);
      }
    }

    state.steps.push({
      index: batchStepIndex,
      thought: parsed.thought,
      actionPairs: batchPairs,
      actions: effectiveBatchCalls,
      observations,
      durationMs: batchDurationMs,
      tokenCount: { input: inputTokens, output: outputTokens },
      ...(batchFrames.length > 0 ? { evidenceFrames: batchFrames } : {}),
    });

    for (let bi = 0; bi < batchResults.length; bi++) {
      const result = batchResults[bi]!;
      const call = effectiveBatchCalls[bi]!;
      const obs = observations[bi] ?? '';
      state.toolOutcomes.push(
        buildToolOutcome(requestId, batchStepIndex, bi, call.tool, obs, result.rawResult, batchDurationMs, false, false, false),
      );
    }

    this.policy.maybeInjectRefinementHint(state, observations, effectiveConfig.maxSteps - budget.getStepCount());

    if (!await this.deps.contractExecutionPhase.runDrinkabilityChecks(queryExecutionContract, requestId, effectiveConfig, budget, state, abortSignal)) {
      return true;
    }
    return false;
  }

  private async runSingleTool(
    requestId: string,
    effectiveConfig: AgentConfig,
    budget: StepBudget,
    state: AgentExecutionState,
    queryExecutionContract: AgentQueryExecutionContract,
    pendingDrinkabilityEntityIds: readonly string[],
    plannerPhase: PlannerPhaseResult,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const { stepStartMs, parsed, inputTokens, outputTokens } = plannerPhase;
    const { tool, input } = parsed.action!;
    const effectiveInput = this.policy.resolveSingleTool({
      tool,
      input,
      queryExecutionContract,
    });

    const pendingSingleViolation = this.contractPolicy.validateDrinkabilitySingleStep(
      pendingDrinkabilityEntityIds,
      tool,
      effectiveInput,
    );
    if (pendingSingleViolation !== null) {
      const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
      this.resultPolicy.recordSingleToolStep({
        requestId,
        stepIndex: state.steps.length,
        thought: parsed.thought,
        tool,
        input: effectiveInput,
        observation: pendingSingleViolation,
        rawResult: null,
        durationMs: stepDurationMs,
        inputTokens,
        outputTokens,
        state,
        execError: false,
        timedOut: false,
        policyViolation: true,
      });
      return false;
    }

    if (!isKnownTool(tool)) {
      const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
      return this.resultPolicy.applyUnknownTool({
        requestId,
        stepIndex: state.steps.length,
        thought: parsed.thought,
        tool,
        toolInput: effectiveInput,
        durationMs: stepDurationMs,
        inputTokens,
        outputTokens,
        state,
      });
    }

    const loopCheck = budget.recordStep(tool, effectiveInput);
    if (!loopCheck.allowed) {
      state.terminationReason = loopCheck.reason ?? 'loop_detected';
      return true;
    }

    let observation: string;
    let rawResult: unknown;
    let sequentialEvidenceFrame: ToolCallEvidenceFrame | undefined;
    const toolAbortController = new AbortController();
    const propagateToolAbort = (): void => { toolAbortController.abort(); };
    abortSignal?.addEventListener('abort', propagateToolAbort, { once: true });
    try {
      const timedToolResult = await withTimeout(
        executeAgentTool(
          tool,
          effectiveInput,
          this.deps.toolDeps,
          `${requestId}-step${state.steps.length}`,
          {
            abortSignal: toolAbortController.signal,
            toolCallId: toolCallIdForStep(requestId, state.steps.length),
          },
        ),
        getToolTimeoutMs(tool, effectiveConfig.toolTimeoutMs),
        `Tool "${tool}" timed out`,
      );
      observation = truncateObservation(timedToolResult.observation, effectiveConfig.maxContextChars);
      rawResult = timedToolResult.rawResult;
      sequentialEvidenceFrame = timedToolResult.evidenceFrame;
      if (sequentialEvidenceFrame !== undefined) {
        state.collectedFrames.push(sequentialEvidenceFrame);
      }
    } catch (toolErr) {
      toolAbortController.abort();
      const disposition = this.resultPolicy.applySingleExecutionFailure({
        err: toolErr,
        requestId,
        stepIndex: state.steps.length,
        thought: parsed.thought,
        tool,
        input: effectiveInput,
        durationMs: Math.max(0, Date.now() - stepStartMs),
        inputTokens,
        outputTokens,
        state,
      });
      if (disposition.kind === 'terminal') {
        return true;
      }
      log.error({ err: toolErr, requestId, tool }, 'sequential tool execution failed');
      observation = disposition.observation;
      rawResult = disposition.rawResult;
    } finally {
      toolAbortController.abort();
      abortSignal?.removeEventListener('abort', propagateToolAbort);
    }

    if (
      rawResult !== null &&
      typeof rawResult === 'object' &&
      'queryType' in (rawResult as Record<string, unknown>) &&
      (rawResult as Record<string, unknown>)['queryType'] === 'search'
    ) {
      state.lastSearchResult = rawResult as SearchResponseV1;
    }

    const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
    state.steps.push({
      index: state.steps.length,
      thought: parsed.thought,
      action: { tool, input: effectiveInput },
      observation,
      durationMs: stepDurationMs,
      tokenCount: { input: inputTokens, output: outputTokens },
      ...(sequentialEvidenceFrame !== undefined
        ? { evidenceFrames: [sequentialEvidenceFrame] }
        : {}),
    });
    state.toolOutcomes.push(
      buildToolOutcome(requestId, state.steps.length - 1, 0, tool, observation, rawResult, stepDurationMs, rawResult === null, false, false),
    );

    this.policy.maybeInjectRefinementHint(state, [observation], effectiveConfig.maxSteps - budget.getStepCount());

    if (!await this.deps.contractExecutionPhase.runDrinkabilityChecks(queryExecutionContract, requestId, effectiveConfig, budget, state, abortSignal)) {
      return true;
    }
    return false;
  }
}
