import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentToolCallPair } from '../../domain/agent/model/agent-step.js';
import type { ToolCallEvidenceFrame } from '../../domain/agent/model/tool-call-evidence-frame.js';
import { toolCallIdForStep } from '../../domain/agent/service/build-tool-call-evidence-frame.js';
import type { StepBudget } from '../../domain/agent/service/step-budget.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { AgentToolDeps, AgentToolResult } from './agent-tools.js';
import { executeAgentToolsBatch } from './agent-tools.js';
import { truncateObservation } from './agent-prompt.js';
import type { AgentQueryExecutionContract } from './agent-query-execution-contract.js';
import { AgentContractPolicy } from './agent-contract-policy.js';
import {
  buildObservationPairs,
  buildToolOutcome,
  formatPolicyBlockedObservation,
  getParallelBatchTimeoutMs,
  type TimeoutErrorLike,
  withTimeout,
} from './agent-tool-execution-support.js';

const log = bootstrapLogger.child({ component: 'AgentContractExecutionPhase' });

interface AgentContractExecutionPhaseDeps {
  readonly toolDeps: AgentToolDeps;
}

export class AgentContractExecutionPhase {
  private readonly contractPolicy = new AgentContractPolicy();

  constructor(private readonly deps: AgentContractExecutionPhaseDeps) {}

  async runDrinkabilityChecks(
    queryExecutionContract: AgentQueryExecutionContract,
    requestId: string,
    effectiveConfig: AgentConfig,
    budget: StepBudget,
    state: AgentExecutionState,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const pendingIds = this.contractPolicy.getPendingDrinkabilityEntityIds(queryExecutionContract, state);
    if (pendingIds.length === 0) {
      return true;
    }

    const checkCalls = pendingIds.map((entityId) => ({
      tool: 'check_drinking_window',
      input: { entity_id: entityId },
    }));
    const budgetCheck = budget.recordParallelBatch(checkCalls, { skipNearDuplicate: true });
    if (!budgetCheck.allowed) {
      state.terminationReason = budgetCheck.reason ?? 'max_steps';
      return false;
    }

    const stepIndex = state.steps.length;
    const stepStartMs = Date.now();
    const autoAbortController = new AbortController();
    const propagateAutoAbort = (): void => { autoAbortController.abort(); };
    abortSignal?.addEventListener('abort', propagateAutoAbort, { once: true });

    let results: readonly AgentToolResult[];
    try {
      results = await withTimeout(
        executeAgentToolsBatch(
          checkCalls,
          this.deps.toolDeps,
          `${requestId}-step${stepIndex}`,
          {
            abortSignal: autoAbortController.signal,
            toolCallId: toolCallIdForStep(requestId, stepIndex),
          },
        ),
        getParallelBatchTimeoutMs(checkCalls, effectiveConfig.parallelBatchTimeoutMs),
        'Contract drinkability batch timed out',
      );
    } catch (err) {
      autoAbortController.abort();
      const durationMs = Math.max(0, Date.now() - stepStartMs);
      if (isAbortError(err)) {
        state.terminationReason = 'aborted';
        const observation = '[ABORTED] Request cancelled during contract drinkability checks.';
        for (let i = 0; i < checkCalls.length; i++) {
          state.toolOutcomes.push(
            buildToolOutcome(requestId, stepIndex, i, checkCalls[i]!.tool, observation, null, durationMs, true, false, false),
          );
        }
        const { actionPairs, observations } = buildObservationPairs(checkCalls, observation);
        state.steps.push({
          index: stepIndex,
          thought: 'contract: drinkability check after entity retrieval',
          actionPairs,
          actions: checkCalls,
          observations,
          durationMs,
          tokenCount: { input: 0, output: 0 },
        });
        return false;
      }
      if ((err as TimeoutErrorLike).code === 'TIMEOUT') {
        state.timeoutStats.parallelBatch += 1;
        state.terminationReason = 'timeout';
        const observation = '[TIMEOUT] Contract drinkability checks timed out.';
        for (let i = 0; i < checkCalls.length; i++) {
          state.toolOutcomes.push(
            buildToolOutcome(requestId, stepIndex, i, checkCalls[i]!.tool, observation, null, durationMs, false, true, false),
          );
        }
        const { actionPairs, observations } = buildObservationPairs(checkCalls, observation);
        state.steps.push({
          index: stepIndex,
          thought: 'contract: drinkability check after entity retrieval',
          actionPairs,
          actions: checkCalls,
          observations,
          durationMs,
          tokenCount: { input: 0, output: 0 },
        });
        return false;
      }
      if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
        state.policyBlocked = true;
        state.terminationReason = 'blocked';
        const observation = formatPolicyBlockedObservation(err);
        for (let i = 0; i < checkCalls.length; i++) {
          state.toolOutcomes.push(
            buildToolOutcome(requestId, stepIndex, i, checkCalls[i]!.tool, observation, null, durationMs, false, false, true),
          );
        }
        const { actionPairs, observations } = buildObservationPairs(checkCalls, observation);
        state.steps.push({
          index: stepIndex,
          thought: 'contract: drinkability check after entity retrieval',
          actionPairs,
          actions: checkCalls,
          observations,
          durationMs,
          tokenCount: { input: 0, output: 0 },
        });
        return false;
      }
      log.error({ err, requestId, stepIndex }, 'contract drinkability batch failed');
      state.reasoningFailureDetected = true;
      state.terminationReason = 'error';
      return false;
    } finally {
      autoAbortController.abort();
      abortSignal?.removeEventListener('abort', propagateAutoAbort);
    }

    const durationMs = Math.max(0, Date.now() - stepStartMs);
    const observations: string[] = [];
    const actionPairs: AgentToolCallPair[] = [];
    const frames: ToolCallEvidenceFrame[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const call = checkCalls[i]!;
      const observation = truncateObservation(result.observation, effectiveConfig.maxContextChars);
      observations.push(observation);
      actionPairs.push({ action: call, observation });
      if (result.evidenceFrame !== undefined) {
        frames.push(result.evidenceFrame);
        state.collectedFrames.push(result.evidenceFrame);
      }
      state.toolOutcomes.push(
        buildToolOutcome(
          requestId,
          stepIndex,
          i,
          call.tool,
          observation,
          result.rawResult,
          durationMs,
          result.rawResult === null,
          false,
          false,
        ),
      );
    }

    state.steps.push({
      index: stepIndex,
      thought: 'contract: drinkability check after entity retrieval',
      actionPairs,
      actions: checkCalls,
      observations,
      durationMs,
      tokenCount: { input: 0, output: 0 },
      ...(frames.length > 0 ? { evidenceFrames: frames } : {}),
    });
    return true;
  }
}
