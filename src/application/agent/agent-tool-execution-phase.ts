import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentTerminationReason, AgentToolCallPair } from '../../domain/agent/model/agent-step.js';
import type { ToolCallEvidenceFrame } from '../../domain/agent/model/tool-call-evidence-frame.js';
import type { ResultItem } from '../../domain/response/model/result-item.js';
import type { ComparisonEntity, ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import { toolCallIdForStep } from '../../domain/agent/service/build-tool-call-evidence-frame.js';
import type { StepBudget } from '../../domain/agent/service/step-budget.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { AgentExecutionState } from './agent-execution-state.js';
import type { PlannerPhaseResult } from './agent-planner-phase-runner.js';
import type { AgentToolDeps, AgentToolResult } from './agent-tools.js';
import type { RetrievalDrinkingWindowProjection } from '../../domain/retrieval/model/retrieval-document.js';
import {
  executeAgentTool,
  executeAgentToolsBatch,
} from './agent-tools.js';
import { isKnownAgentToolName, KNOWN_AGENT_TOOL_NAMES_DISPLAY } from './agent-tool-attempt-schema.js';
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

type BatchToolCall = {
  readonly tool: string;
  readonly input: Record<string, unknown>;
};

type BatchNormalizationResult =
  | { readonly kind: 'calls'; readonly calls: readonly BatchToolCall[] }
  | { readonly kind: 'defect'; readonly calls: readonly BatchToolCall[]; readonly observation: string };

type CompareMergeConflict = {
  readonly key: string;
  readonly values: readonly unknown[];
};

function formatInvalidParallelBatchObservation(
  reason: string,
  detail: string,
): string {
  return `Invalid parallel batch: ${reason}. ${detail}`;
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForStableJson);
  }
  if (value !== null && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) {
        normalized[key] = normalizeForStableJson(child);
      }
    }
    return normalized;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value)) ?? String(value);
}

function stableEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function dedupeStableValues<T>(values: readonly T[]): readonly T[] {
  const deduped: T[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = stableJson(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(value);
  }
  return deduped;
}

function sameComparePair(
  left: BatchToolCall,
  right: BatchToolCall,
): boolean {
  return typeof left.input['query_a'] === 'string'
    && typeof left.input['query_b'] === 'string'
    && stableEqual(left.input['query_a'], right.input['query_a'])
    && stableEqual(left.input['query_b'], right.input['query_b']);
}

function mergeCompareFieldValues(
  values: readonly unknown[],
): { readonly kind: 'merged'; readonly value: unknown } | { readonly kind: 'conflict'; readonly values: readonly unknown[] } {
  const distinctValues = dedupeStableValues(values);
  if (distinctValues.length === 1) {
    return { kind: 'merged', value: distinctValues[0] };
  }

  if (distinctValues.every(Array.isArray)) {
    const mergedItems: unknown[] = [];
    for (const candidate of distinctValues) {
      for (const item of candidate) {
        if (mergedItems.some((existing) => stableEqual(existing, item))) {
          continue;
        }
        mergedItems.push(item);
      }
    }
    return { kind: 'merged', value: mergedItems };
  }

  return { kind: 'conflict', values: distinctValues };
}

function buildMergedCompareInput(
  compareCalls: readonly BatchToolCall[],
): { readonly kind: 'merged'; readonly input: Record<string, unknown> } | { readonly kind: 'conflict'; readonly conflicts: readonly CompareMergeConflict[] } {
  const merged: Record<string, unknown> = {};
  const conflicts: CompareMergeConflict[] = [];
  const keys = new Set<string>();
  for (const call of compareCalls) {
    for (const key of Object.keys(call.input)) {
      keys.add(key);
    }
  }

  for (const key of [...keys].sort()) {
    const values = compareCalls
      .map((call) => call.input[key])
      .filter((value): value is NonNullable<unknown> => value !== undefined);
    if (values.length === 0) {
      continue;
    }
    const mergeResult = mergeCompareFieldValues(values);
    if (mergeResult.kind === 'conflict') {
      conflicts.push({
        key,
        values: mergeResult.values,
      });
      continue;
    }
    merged[key] = mergeResult.value;
  }

  if (conflicts.length > 0) {
    return { kind: 'conflict', conflicts };
  }

  return { kind: 'merged', input: merged };
}

function normalizeCompareBatch(
  calls: readonly BatchToolCall[],
): BatchNormalizationResult {
  const compareCalls = calls.filter((call) => call.tool === 'compare_wines');
  if (compareCalls.length === 0) {
    return { kind: 'calls', calls };
  }

  if (compareCalls.length !== calls.length) {
    const coTools = dedupeStableValues(calls
      .filter((call) => call.tool !== 'compare_wines')
      .map((call) => call.tool));
    return {
      kind: 'defect',
      calls,
      observation: formatInvalidParallelBatchObservation(
        'compare_wines_must_run_alone',
        `Planner defect: compare_wines cannot share a parallel batch with ${coTools.join(', ')}. Preserve all requested calls, execute compare_wines in its own step, then replan the remaining tool calls sequentially.`,
      ),
    };
  }

  if (compareCalls.length === 1) {
    return { kind: 'calls', calls };
  }
  const firstCompare = compareCalls[0]!;
  if (!compareCalls.every((call) => sameComparePair(firstCompare, call))) {
    return {
      kind: 'defect',
      calls,
      observation: formatInvalidParallelBatchObservation(
        'multiple_compare_wines_calls',
        'Planner defect: multiple compare_wines calls were requested in one parallel batch. compare_wines must run alone; split each comparison into its own sequential step.',
      ),
    };
  }
  const mergedInput = buildMergedCompareInput(compareCalls);
  if (mergedInput.kind === 'conflict') {
    const conflictingKeys = mergedInput.conflicts.map((conflict) => conflict.key).sort();
    return {
      kind: 'defect',
      calls,
      observation: formatInvalidParallelBatchObservation(
        'conflicting_duplicate_compare_constraints',
        `Planner defect: conflicting duplicate compare_wines constraints for the same pair on keys [${conflictingKeys.join(', ')}]. Preserve every constraint and replan with one lossless compare_wines call or separate sequential steps; do not weaken constraints.`,
      ),
    };
  }

  return {
    kind: 'calls',
    calls: [{
      tool: 'compare_wines',
      input: mergedInput.input,
    }],
  };
}

const FORBIDDEN_PLACEHOLDER_VALUES = new Set([
  '__TO_BE_FILLED__',
  '<top_result_entity_id>',
  '{{id}}',
  'TBD',
  'PLACEHOLDER',
]);

function isForbiddenPlaceholderValue(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (FORBIDDEN_PLACEHOLDER_VALUES.has(trimmed)) {
    return true;
  }
  const normalized = trimmed.toLowerCase().replace(/[\s-]+/gu, '_');
  return (
    /^<[^>]+>$/u.test(trimmed) &&
    /(?:to_be_filled|fill(?:ed)?_later|top_result|placeholder|entity_id|tbd)/u.test(normalized)
  )
    || /^(?:to_be_filled|fill(?:ed)?_later|top_result_entity_id|placeholder|tbd)$/u.test(normalized);
}

function isUnresolvedDrinkabilityCheck(call: BatchToolCall): boolean {
  return call.tool === 'check_drinking_window'
    && (
      call.input['entity_id'] === undefined ||
      isForbiddenPlaceholderValue(call.input['entity_id'])
    );
}

function buildDrinkingWindowProjectionFromResultItem(
  item: ResultItem | null | undefined,
): RetrievalDrinkingWindowProjection | undefined {
  if (item?.drinkingWindow === undefined) {
    return undefined;
  }
  return {
    entityId: item.entity.entityId,
    canonicalLabel: item.entity.canonicalLabel,
    drinkingWindowStart: item.drinkingWindow.drinkingWindowStart,
    drinkingWindowEnd: item.drinkingWindow.drinkingWindowEnd,
    ...(item.drinkingWindow.modelVersion !== undefined
      ? { drinkingWindowModelVersion: item.drinkingWindow.modelVersion }
      : {}),
  };
}

function ingestDrinkingWindowProjection(
  state: AgentExecutionState,
  projection: RetrievalDrinkingWindowProjection | undefined,
): void {
  if (projection === undefined) {
    return;
  }
  if (projection.drinkingWindowStart === undefined || projection.drinkingWindowEnd === undefined) {
    return;
  }
  state.groundedDrinkingWindowByEntityId.set(projection.entityId, projection);
}

function collectComparisonLegCandidates(entity: ComparisonEntity): readonly ResultItem[] {
  const candidates: ResultItem[] = [];
  const push = (item: ResultItem | null | undefined): void => {
    if (item === null || item === undefined) {
      return;
    }
    if (candidates.some((existing) => existing.entity.entityId === item.entity.entityId)) {
      return;
    }
    candidates.push(item);
  };

  push(entity.topResult);
  push(entity.conceptAggregate?.representativeResult ?? undefined);
  for (const item of entity.allResults) {
    push(item);
  }
  return candidates;
}

function ingestGroundedDrinkabilityFromRawResult(
  state: AgentExecutionState,
  rawResult: unknown,
): void {
  if (rawResult === null || typeof rawResult !== 'object') {
    return;
  }
  const result = rawResult as Record<string, unknown>;
  if (result['queryType'] === 'search') {
    const search = rawResult as SearchResponseV1;
    for (const item of search.results) {
      ingestDrinkingWindowProjection(state, buildDrinkingWindowProjectionFromResultItem(item));
    }
    return;
  }
  if (result['queryType'] === 'comparison') {
    const comparison = rawResult as ComparisonSearchResponse;
    for (const entity of comparison.entities) {
      for (const item of collectComparisonLegCandidates(entity)) {
        ingestDrinkingWindowProjection(state, buildDrinkingWindowProjectionFromResultItem(item));
      }
    }
  }
}

function detectDeferredDrinkabilityBatchDefect(
  calls: readonly BatchToolCall[],
  queryExecutionContract: AgentQueryExecutionContract,
): BatchNormalizationResult | null {
  if (!queryExecutionContract.requiresDrinkabilityCheck || calls.length < 2) {
    return null;
  }

  const unresolvedDrinkabilityChecks = calls.filter(isUnresolvedDrinkabilityCheck);
  if (unresolvedDrinkabilityChecks.length === 0) {
    return null;
  }

  const coTools = dedupeStableValues(calls
    .filter((call) => !isUnresolvedDrinkabilityCheck(call))
    .map((call) => call.tool));
  if (coTools.length === 0) {
    return null;
  }

  return {
    kind: 'defect',
    calls,
    observation: formatInvalidParallelBatchObservation(
      'deferred_drinkability_requires_prior_retrieval',
      `Planner defect: Deferred drinkability placeholders cannot run in the same batch as ${coTools.join(', ')}. Preserve all requested calls, execute the retrieval step first, then replan concrete check_drinking_window(entity_id=...) calls with resolved entity ids.`,
    ),
  };
}

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

  private buildRuntimeToolDeps(state: AgentExecutionState): AgentToolDeps {
    return {
      ...this.deps.toolDeps,
      groundedDrinkingWindowLookup: (id) => state.groundedDrinkingWindowByEntityId.get(String(id)),
    };
  }

  private applyPlannerRepairToObservation(
    observation: string,
    repairObservation: string | undefined,
  ): string {
    if (repairObservation === undefined || repairObservation.trim().length === 0) {
      return observation;
    }
    return `[PLANNER_REPAIR] ${repairObservation}\n${observation}`;
  }

  private recordBatchPolicyViolation(
    requestId: string,
    stepIndex: number,
    thought: string,
    calls: readonly BatchToolCall[],
    observation: string,
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
    state: AgentExecutionState,
    reasoningFailureDetected: boolean = false,
    plannerRepairObservation?: string,
  ): false {
    if (reasoningFailureDetected) {
      state.reasoningFailureDetected = true;
    }
    this.resultPolicy.recordBatchStep({
      requestId,
      stepIndex,
      thought,
      calls,
      observation: this.applyPlannerRepairToObservation(observation, plannerRepairObservation),
      durationMs,
      inputTokens,
      outputTokens,
      state,
      execError: false,
      timedOut: false,
      policyViolation: true,
    });
    return false;
  }

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

    if (parsed.plannerDefect !== undefined) {
      state.reasoningFailureDetected = true;
      state.plannerDefectAttempts += 1;
      state.steps.push({
        index: state.steps.length,
        thought: parsed.thought,
        observation: parsed.plannerDefect.observation,
        durationMs: Math.max(0, Date.now() - stepStartMs),
        tokenCount: { input: inputTokens, output: outputTokens },
      });

      if (state.plannerDefectAttempts > 2) {
        state.terminationReason = 'error';
        return true;
      }
      return false;
    }

    if (typeof parsed.answer === 'string') {
      const trimmedAnswer = parsed.answer.trim();
      if (trimmedAnswer.length > 0) {
        if (state.pendingRefinementRetry) {
          state.pendingPlannerDirective = { kind: 'relax_constraints_retry' };
          return false;
        }
        if (queryExecutionContract.requiresGroundedWineSearch === true && state.toolOutcomes.length === 0) {
          state.reasoningFailureDetected = true;
          state.pendingPlannerDirective = this.contractPolicy.buildGroundedSearchDirective();
          return false;
        }
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
      const expandedCalls = this.policy.resolveSingleCallExpansion({
        tool: parsed.action.tool,
        input: parsed.action.input,
        queryExecutionContract,
      });
      if (expandedCalls !== undefined) {
        return await this.runParallelBatch(
          requestId,
          effectiveConfig,
          budget,
          state,
          queryExecutionContract,
          pendingDrinkabilityEntityIds,
          {
            ...plannerPhase,
            parsed: {
              thought: parsed.thought,
              actions: expandedCalls,
              ...(parsed.plannerRepair !== undefined ? { plannerRepair: parsed.plannerRepair } : {}),
            },
          },
          abortSignal,
        );
      }
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
    const plannerRepairObservation = parsed.plannerRepair?.observation;
    if (plannerRepairObservation !== undefined) {
      state.reasoningFailureDetected = true;
    }

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
        observation: this.applyPlannerRepairToObservation(
          pendingBatchViolation,
          plannerRepairObservation,
        ),
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
        observation: this.applyPlannerRepairToObservation(batchErrorMsg, plannerRepairObservation),
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

    const unknownTool = batchCalls.find((c) => !isKnownAgentToolName(c.tool));
    if (unknownTool !== undefined) {
      state.reasoningFailureDetected = true;
      state.unknownToolAttempts++;
      if (state.unknownToolAttempts > 2) {
        state.terminationReason = 'error';
        return true;
      }
      const unknownToolMsg = `Unknown tool: ${unknownTool.tool}. Available: ${KNOWN_AGENT_TOOL_NAMES_DISPLAY}`;
      this.resultPolicy.recordBatchStep({
        requestId,
        stepIndex: batchStepIndex,
        thought: parsed.thought,
        calls: batchCalls,
        observation: this.applyPlannerRepairToObservation(
          unknownToolMsg,
          plannerRepairObservation,
        ),
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

    let effectiveBatchCalls = this.policy.resolveParallelBatch({
      calls: batchCalls,
      queryExecutionContract,
    });
    const deferredDrinkabilityDefect = detectDeferredDrinkabilityBatchDefect(
      effectiveBatchCalls,
      queryExecutionContract,
    );
    if (deferredDrinkabilityDefect?.kind === 'defect') {
      return this.recordBatchPolicyViolation(
        requestId,
        batchStepIndex,
        parsed.thought,
        deferredDrinkabilityDefect.calls,
        deferredDrinkabilityDefect.observation,
        batchDurationMs,
        inputTokens,
        outputTokens,
        state,
        true,
        plannerRepairObservation,
      );
    }
    const normalizedCompareBatch = normalizeCompareBatch(effectiveBatchCalls);
    if (normalizedCompareBatch.kind === 'defect') {
      return this.recordBatchPolicyViolation(
        requestId,
        batchStepIndex,
        parsed.thought,
        normalizedCompareBatch.calls,
        normalizedCompareBatch.observation,
        batchDurationMs,
        inputTokens,
        outputTokens,
        state,
        true,
        plannerRepairObservation,
      );
    }
    effectiveBatchCalls = normalizedCompareBatch.calls;

    const batchPolicy = evaluateBatchPolicy(effectiveBatchCalls);
    if (!batchPolicy.allowed) {
      const policyReason = 'reason' in batchPolicy ? batchPolicy.reason : 'invalid_parallel_batch';
      const policyMsg = `Invalid parallel batch: ${policyReason}. Allowed: search_wines+search_wines/get_food_pairings, or check_drinking_window-only batches, or compare_wines alone.`;
      return this.recordBatchPolicyViolation(
        requestId,
        batchStepIndex,
        parsed.thought,
        effectiveBatchCalls,
        policyMsg,
        batchDurationMs,
        inputTokens,
        outputTokens,
        state,
        false,
        plannerRepairObservation,
      );
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
          this.buildRuntimeToolDeps(state),
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
        observationContext: plannerRepairObservation,
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
      const obs = truncateObservation(
        this.applyPlannerRepairToObservation(
          result.observation,
          plannerRepairObservation,
        ),
        effectiveConfig.maxContextChars,
      );
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
      ingestGroundedDrinkabilityFromRawResult(state, result.rawResult);
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

    state.pendingRefinementRetry = false;
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
    const plannerRepairObservation = parsed.plannerRepair?.observation;
    if (plannerRepairObservation !== undefined) {
      state.reasoningFailureDetected = true;
    }
    const effectiveCall = this.policy.resolveSingleCall({
      tool,
      input,
      queryExecutionContract,
    });
    const effectiveTool = effectiveCall.tool;
    const effectiveInput = effectiveCall.input;

    const pendingSingleViolation = this.contractPolicy.validateDrinkabilitySingleStep(
      pendingDrinkabilityEntityIds,
      effectiveTool,
      effectiveInput,
    );
    if (pendingSingleViolation !== null) {
      const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
      this.resultPolicy.recordSingleToolStep({
        requestId,
        stepIndex: state.steps.length,
        thought: parsed.thought,
        tool: effectiveTool,
        input: effectiveInput,
        observation: this.applyPlannerRepairToObservation(
          pendingSingleViolation,
          plannerRepairObservation,
        ),
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

    if (!isKnownAgentToolName(effectiveTool)) {
      const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
      return this.resultPolicy.applyUnknownTool({
        requestId,
        stepIndex: state.steps.length,
        thought: parsed.thought,
        tool: effectiveTool,
        toolInput: effectiveInput,
        durationMs: stepDurationMs,
        inputTokens,
        outputTokens,
        state,
        observationContext: plannerRepairObservation,
      });
    }

    const loopCheck = budget.recordStep(effectiveTool, effectiveInput);
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
          effectiveTool,
          effectiveInput,
          this.buildRuntimeToolDeps(state),
          `${requestId}-step${state.steps.length}`,
          {
            abortSignal: toolAbortController.signal,
            toolCallId: toolCallIdForStep(requestId, state.steps.length),
          },
        ),
        getToolTimeoutMs(effectiveTool, effectiveConfig.toolTimeoutMs),
        `Tool "${effectiveTool}" timed out`,
      );
      observation = truncateObservation(
        this.applyPlannerRepairToObservation(timedToolResult.observation, plannerRepairObservation),
        effectiveConfig.maxContextChars,
      );
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
        tool: effectiveTool,
        input: effectiveInput,
        durationMs: Math.max(0, Date.now() - stepStartMs),
        inputTokens,
        outputTokens,
        state,
        observationContext: plannerRepairObservation,
      });
      if (disposition.kind === 'terminal') {
        return true;
      }
      log.error({ err: toolErr, requestId, tool: effectiveTool }, 'sequential tool execution failed');
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
    ingestGroundedDrinkabilityFromRawResult(state, rawResult);

    const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
    state.steps.push({
      index: state.steps.length,
      thought: parsed.thought,
      action: { tool: effectiveTool, input: effectiveInput },
      observation,
      durationMs: stepDurationMs,
      tokenCount: { input: inputTokens, output: outputTokens },
      ...(sequentialEvidenceFrame !== undefined
        ? { evidenceFrames: [sequentialEvidenceFrame] }
        : {}),
    });
    state.toolOutcomes.push(
      buildToolOutcome(requestId, state.steps.length - 1, 0, effectiveTool, observation, rawResult, stepDurationMs, rawResult === null, false, false),
    );

    state.pendingRefinementRetry = false;
    this.policy.maybeInjectRefinementHint(state, [observation], effectiveConfig.maxSteps - budget.getStepCount());

    if (!await this.deps.contractExecutionPhase.runDrinkabilityChecks(queryExecutionContract, requestId, effectiveConfig, budget, state, abortSignal)) {
      return true;
    }
    return false;
  }
}
