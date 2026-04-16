/**
 * ReAct Agent Orchestrator — the core agentic loop.
 *
 * Flow:
 *   1. Build system prompt + user query
 *   2. Loop: LLM reasons → tool call OR answer
 *   3. Tool results become observations → feed back to LLM
 *   4. Terminate on: answer | max_steps | timeout | loop | error
 *   5. Fallback to single-shot search if LLM fails entirely
 *
 * All search execution uses existing use cases unchanged.
 */

import type { ChatLlmPort } from '../../domain/ai/port/chat-llm.port.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../domain/shared/error/policy-blocked.js';
import { CIRCUIT_BREAKER_OPEN_CODE } from '../../domain/shared/error/circuit-breaker-open-error.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { AgentConfig } from '../../domain/agent/model/agent-config.js';
import type { AgentResult } from '../../domain/agent/model/agent-result.js';
import type { AgentStep, AgentToolCallPair, AgentTerminationReason } from '../../domain/agent/model/agent-step.js';
import { DEFAULT_AGENT_CONFIG } from '../../domain/agent/model/agent-config.js';
import { StepBudget } from '../../domain/agent/service/step-budget.js';
import { classifyQueryBudget } from '../../domain/agent/service/adaptive-budget.js';
import {
  truncateObservation,
} from './agent-prompt.js';
import {
  executeAgentTool,
  executeAgentToolsBatch,
  isKnownTool,
  type AgentToolDeps,
  type AgentToolResult,
} from './agent-tools.js';
import type { ToolCallEvidenceFrame } from '../../domain/agent/model/tool-call-evidence-frame.js';
import { toolCallIdForStep } from '../../domain/agent/service/build-tool-call-evidence-frame.js';
import { evaluateBatchPolicy } from './tool-batch-policy.js';
import {
  buildSynthesisContext,
  type ExpectedOutputSchema,
  isAgentToolName,
  type ToolOutcome,
  type ToolOutcomeKind,
} from './tool-outcome.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import type { AgentExecutionObserver } from '../../domain/agent/port/agent-execution-observer.port.js';
import { QueryNormalizer } from '../../domain/query/service/query-normalizer.js';
import {
  hasDrinkabilityKeyword,
  hasEntityMetadataKeyword,
} from '../../domain/query/service/planner-intent-detection.js';
import { PolicyBlockedError } from '../../domain/shared/error/policy-blocked.js';
import {
  createAgentExecutionState,
  type AgentExecutionState,
} from './agent-execution-state.js';
import {
  AgentFallbackFinalizer,
  hasToolObservations,
} from './agent-fallback-finalizer.js';
import {
  AgentPlannerPhaseRunner,
  type PlannerPhaseResult,
} from './agent-planner-phase-runner.js';
import { AgentObservationSynthesisRunner } from './agent-observation-synthesis-runner.js';

const log = bootstrapLogger.child({ component: 'AgentOrchestrator' });

/** Default single-tool timeout (separate from LLM step timeout). */
const DEFAULT_TOOL_TIMEOUT_MS = 8_000;
/**
 * Search executes the full retrieval/ranking stack, so it needs a wider budget
 * than metadata tools to avoid false timeout fallbacks on clean real-data runs.
 */
const DEFAULT_SEARCH_TOOL_TIMEOUT_MS = 18_000;
/** Default parallel-batch timeout (caps total Promise.all wait). */
const DEFAULT_PARALLEL_BATCH_TIMEOUT_MS = 20_000;
/** Hard cap on parallel tools per batch step. */
const MAX_TOOLS_PER_BATCH = 4;
/** Log-preview chars for non-parseable LLM text — enough to diagnose without bloating the log line. */

/**
 * E7-T2: Classify a tool call's ToolOutcomeKind from its observation string and error state.
 *
 * Classification priority:
 *  1. Timed-out (TIMEOUT prefix)
 *  2. Policy blocked (Policy blocked: prefix)
 *  3. Tool error (Tool error: prefix or rawResult null from error path)
 *  4. Empty result (0개 / NO_MATCH / 검색 결과가 없습니다)
 *  5. Success (rawResult is a SearchResponseV1 with results)
 *  6. Default: success (non-null rawResult)
 */
function classifyToolOutcomeKind(
  observation: string,
  rawResult: unknown,
  execError: boolean,
  timedOut: boolean,
  policyBlocked: boolean,
): ToolOutcomeKind {
  if (timedOut) return 'timeout';
  if (policyBlocked) return 'policy_violation';
  if (execError) return 'tool_error';
  if (
    observation.startsWith('NO_MATCH:') ||
    observation.includes('0개') ||
    observation.includes('검색 결과가 없습니다')
  ) return 'empty_result';
  if (rawResult != null) return 'success';
  return 'tool_error';
}

function buildToolOutcomeStepId(
  requestId: string,
  stepIndex: number,
  toolPosition: number,
): string {
  return `${requestId}:${stepIndex}:${toolPosition}`;
}

function getExpectedOutputSchema(tool: string): ExpectedOutputSchema | undefined {
  if (tool === 'search_wines' || tool === 'get_food_pairings') {
    return {
      minResults: 1,
      requiredFields: ['entity.entityId', 'entity.canonicalLabel'],
    };
  }
  if (tool === 'compare_wines') {
    return {
      minResults: 2,
      requiredFields: ['topResult.entity.entityId', 'topResult.entity.canonicalLabel'],
    };
  }
  if (tool === 'check_drinking_window') {
    return {
      requiredFields: ['drinkingWindowStart', 'drinkingWindowEnd', 'currentlyDrinkable'],
    };
  }
  return undefined;
}

function getComparableResultItems(tool: string, rawResult: unknown): readonly unknown[] | undefined {
  if (typeof rawResult !== 'object' || rawResult === null) {
    return undefined;
  }
  const record = rawResult as Record<string, unknown>;
  if (
    (tool === 'search_wines' || tool === 'get_food_pairings') &&
    record['queryType'] === 'search' &&
    Array.isArray(record['results'])
  ) {
    return record['results'] as unknown[];
  }
  if (tool === 'compare_wines' && record['queryType'] === 'comparison' && Array.isArray(record['entities'])) {
    return record['entities']
      .filter((entity): entity is Record<string, unknown> => typeof entity === 'object' && entity !== null)
      .filter((entity) => entity['topResult'] !== null);
  }
  if (tool === 'check_drinking_window') {
    return [record];
  }
  return undefined;
}

function getValueAtPath(input: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = input;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateToolPostconditions(tool: string, rawResult: unknown): readonly string[] {
  const expected = getExpectedOutputSchema(tool);
  const items = getComparableResultItems(tool, rawResult);
  if (expected === undefined || items === undefined) {
    return [];
  }

  const violations: string[] = [];
  if (expected.minResults !== undefined && items.length < expected.minResults) {
    violations.push(`minResults: expected >=${expected.minResults}, got ${items.length}`);
  }
  for (const field of expected.requiredFields ?? []) {
    if (items.some((item) => getValueAtPath(item, field) == null)) {
      violations.push(`requiredFields: missing ${field}`);
    }
  }
  return violations;
}

function buildToolOutcome(
  requestId: string,
  stepIndex: number,
  toolPosition: number,
  tool: string,
  observation: string,
  rawResult: unknown,
  durationMs: number,
  execError: boolean,
  timedOut: boolean,
  policyViolation: boolean,
): ToolOutcome {
  const baseKind = classifyToolOutcomeKind(
    observation,
    rawResult,
    execError,
    timedOut,
    policyViolation,
  );
  const postconditionViolations =
    baseKind === 'success' && isAgentToolName(tool)
      ? validateToolPostconditions(tool, rawResult)
      : [];
  const kind =
    baseKind === 'success' && postconditionViolations.length > 0
      ? 'partial_result'
      : baseKind;
  return {
    stepId: buildToolOutcomeStepId(requestId, stepIndex, toolPosition),
    tool: isAgentToolName(tool) ? tool : tool,
    kind,
    ...(rawResult != null ? { result: rawResult } : {}),
    ...((kind === 'tool_error' || kind === 'timeout' || kind === 'policy_violation')
      ? { errorMessage: observation }
      : {}),
    ...(postconditionViolations.length > 0 ? { postconditionViolations } : {}),
    durationMs,
  };
}

const QUERY_NORMALIZER = new QueryNormalizer();
const EXACT_METADATA_ALLOWED_SEARCH_KEYS = new Set(['query', 'limit', 'retrieval_mode']);

interface AgentQueryExecutionContract {
  readonly requiresDrinkabilityCheck: boolean;
  readonly hasEntityMetadataSignal: boolean;
}

function buildAgentQueryExecutionContract(query: string): AgentQueryExecutionContract {
  const normalized = QUERY_NORMALIZER.normalize(query).accentless;
  return {
    requiresDrinkabilityCheck: hasDrinkabilityKeyword(normalized),
    hasEntityMetadataSignal: hasEntityMetadataKeyword(normalized),
  };
}

function isSpecificSkuLikeQuery(query: string): boolean {
  return classifyQueryBudget(query)?.classification === 'specific_sku';
}

function getStructuredSearchFilterKeys(input: Record<string, unknown>): readonly string[] {
  return Object.entries(input)
    .filter(([key, value]) =>
      !EXACT_METADATA_ALLOWED_SEARCH_KEYS.has(key) &&
      value !== undefined &&
      value !== null,
    )
    .map(([key]) => key);
}

function normalizeExactMetadataSearchInput(
  input: Record<string, unknown>,
): { readonly effectiveInput: Record<string, unknown>; readonly strippedFilterKeys: readonly string[] } {
  const strippedFilterKeys = getStructuredSearchFilterKeys(input);
  if (strippedFilterKeys.length === 0) {
    return { effectiveInput: input, strippedFilterKeys };
  }

  const filteredEntries = Object.entries(input).filter(
    ([key, value]) =>
      EXACT_METADATA_ALLOWED_SEARCH_KEYS.has(key) &&
      value !== undefined &&
      value !== null,
  );
  return {
    effectiveInput: Object.fromEntries(filteredEntries),
    strippedFilterKeys,
  };
}

function getToolTimeoutMs(
  tool: string,
  configuredTimeoutMs?: number,
): number {
  if (configuredTimeoutMs !== undefined) {
    return configuredTimeoutMs;
  }
  return tool === 'search_wines'
    ? DEFAULT_SEARCH_TOOL_TIMEOUT_MS
    : DEFAULT_TOOL_TIMEOUT_MS;
}

function getParallelBatchTimeoutMs(
  tools: readonly { readonly tool: string }[],
  configuredTimeoutMs?: number,
): number {
  if (configuredTimeoutMs !== undefined) {
    return configuredTimeoutMs;
  }
  if (tools.some((tool) => tool.tool === 'search_wines')) {
    return DEFAULT_PARALLEL_BATCH_TIMEOUT_MS;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

function getCompletedDrinkabilityEntityIds(
  steps: readonly AgentStep[],
): ReadonlySet<string> {
  const entityIds = new Set<string>();
  for (const step of steps) {
    if (step.action?.tool === 'check_drinking_window') {
      const entityId = step.action.input['entity_id'];
      if (typeof entityId === 'string' && entityId.trim().length > 0) {
        entityIds.add(entityId);
      }
    }
    for (const pair of step.actionPairs ?? []) {
      if (pair.action.tool !== 'check_drinking_window') {
        continue;
      }
      const entityId = pair.action.input['entity_id'];
      if (typeof entityId === 'string' && entityId.trim().length > 0) {
        entityIds.add(entityId);
      }
    }
  }
  return entityIds;
}

function extractPendingDrinkabilityEntityIds(
  contract: AgentQueryExecutionContract,
  steps: readonly AgentStep[],
  toolOutcomes: readonly ToolOutcome[],
): readonly string[] {
  if (!contract.requiresDrinkabilityCheck) {
    return [];
  }
  const completed = getCompletedDrinkabilityEntityIds(steps);
  for (let i = toolOutcomes.length - 1; i >= 0; i--) {
    const outcome = toolOutcomes[i]!;
    const result = outcome.result;
    if (typeof result !== 'object' || result === null) {
      continue;
    }
    const record = result as Record<string, unknown>;
    if (outcome.tool === 'search_wines' && record['queryType'] === 'search') {
      const results = record['results'];
      if (!Array.isArray(results) || results.length === 0) {
        return [];
      }
      const [topResult] = results as readonly unknown[];
      const entityId = getValueAtPath(topResult, 'entity.entityId');
      if (typeof entityId === 'string' && entityId.length > 0) {
        return completed.has(entityId) ? [] : [entityId];
      }
      return [];
    }
    if (outcome.tool === 'compare_wines' && record['queryType'] === 'comparison') {
      const entities = record['entities'];
      if (!Array.isArray(entities)) {
        return [];
      }
      const pending = entities
        .map((entity) => getValueAtPath(entity, 'topResult.entity.entityId'))
        .filter((entityId): entityId is string => typeof entityId === 'string' && entityId.length > 0)
        .filter((entityId) => !completed.has(entityId));
      return pending;
    }
  }
  return [];
}

function formatPolicyBlockedObservation(err: DomainError): string {
  if (err instanceof PolicyBlockedError && err.rejection !== undefined) {
    const { layer, reason } = err.rejection;
    if (layer !== undefined || reason !== undefined) {
      return `Policy blocked: ${err.message} [${layer ?? 'UNKNOWN_LAYER'}:${reason ?? 'UNKNOWN_REASON'}]`;
    }
  }
  return `Policy blocked: ${err.message}`;
}

interface TimeoutErrorLike extends Error {
  readonly code?: string;
}

function makeTimeoutError(message: string): TimeoutErrorLike {
  return Object.assign(new Error(message), { code: 'TIMEOUT' });
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(makeTimeoutError(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export interface AgentOrchestratorDeps {
  readonly chatLlm: ChatLlmPort;
  readonly toolDeps: AgentToolDeps;
  /** Optional observer for run-level metrics/telemetry emission. */
  readonly executionObserver?: AgentExecutionObserver | undefined;
  /**
   * Optional pre-execution security gate. When provided, queries that fail
   * sanitization (injection, jailbreak, PII extraction, etc.) are refused
   * immediately without calling any LLM or tool — they return terminationReason='blocked'.
   * When absent, the per-tool security gates still apply (defence-in-depth).
   */
  readonly querySanitizer?: QuerySanitizer | undefined;
}

export class AgentOrchestrator {
  private readonly config: AgentConfig;
  private readonly fallbackFinalizer: AgentFallbackFinalizer;
  private readonly plannerPhaseRunner: AgentPlannerPhaseRunner;
  private readonly observationSynthesisRunner: AgentObservationSynthesisRunner;

  constructor(
    private readonly deps: AgentOrchestratorDeps,
    config?: Partial<AgentConfig>,
  ) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
    this.fallbackFinalizer = new AgentFallbackFinalizer({ toolDeps: deps.toolDeps });
    this.plannerPhaseRunner = new AgentPlannerPhaseRunner({ chatLlm: deps.chatLlm });
    this.observationSynthesisRunner = new AgentObservationSynthesisRunner({ chatLlm: deps.chatLlm });
  }

  private createExecutionState(): AgentExecutionState {
    return createAgentExecutionState();
  }

  private async runContractDrinkabilityChecks(
    queryExecutionContract: AgentQueryExecutionContract,
    requestId: string,
    effectiveConfig: AgentConfig,
    budget: StepBudget,
    state: AgentExecutionState,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const pendingIds = extractPendingDrinkabilityEntityIds(
      queryExecutionContract,
      state.steps,
      state.toolOutcomes,
    );
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
        state.steps.push({
          index: stepIndex,
          thought: 'contract: drinkability check after entity retrieval',
          actionPairs: checkCalls.map((call) => ({ action: call, observation })),
          actions: checkCalls,
          observations: checkCalls.map(() => observation),
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
        state.steps.push({
          index: stepIndex,
          thought: 'contract: drinkability check after entity retrieval',
          actionPairs: checkCalls.map((call) => ({ action: call, observation })),
          actions: checkCalls,
          observations: checkCalls.map(() => observation),
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
        state.steps.push({
          index: stepIndex,
          thought: 'contract: drinkability check after entity retrieval',
          actionPairs: checkCalls.map((call) => ({ action: call, observation })),
          actions: checkCalls,
          observations: checkCalls.map(() => observation),
          durationMs,
          tokenCount: { input: 0, output: 0 },
        });
        return false;
      }
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

  private async runStepExecutorPhase(
    requestId: string,
    effectiveConfig: AgentConfig,
    budget: StepBudget,
    state: AgentExecutionState,
    queryExecutionContract: AgentQueryExecutionContract,
    plannerPhase: PlannerPhaseResult,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const { parsed, inputTokens, outputTokens, stepStartMs } = plannerPhase;
    const pendingDrinkabilityEntityIds = extractPendingDrinkabilityEntityIds(
      queryExecutionContract,
      state.steps,
      state.toolOutcomes,
    );

    if (typeof parsed.answer === 'string') {
      const trimmedAnswer = parsed.answer.trim();
      if (trimmedAnswer.length > 0) {
        if (pendingDrinkabilityEntityIds.length > 0) {
          state.pendingRefinementHint =
            `HINT: This query asks about drinkability. Before answering, you MUST call check_drinking_window for ${pendingDrinkabilityEntityIds.map((id) => `"${id}"`).join(', ')} using the literal entity_id from the latest search/comparison result.`;
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
      const batchCalls = parsed.actions;
      const batchStepIndex = state.steps.length;
      const batchDurationMs = Math.max(0, Date.now() - stepStartMs);

      if (pendingDrinkabilityEntityIds.length > 0) {
        const requestedIds = new Set(
          batchCalls
            .filter((call) => call.tool === 'check_drinking_window')
            .map((call) => call.input['entity_id'])
            .filter((entityId): entityId is string => typeof entityId === 'string' && entityId.trim().length > 0),
        );
        const missingIds = pendingDrinkabilityEntityIds.filter((entityId) => !requestedIds.has(entityId));
        const hasOnlyDrinkabilityChecks = batchCalls.every((call) => call.tool === 'check_drinking_window');
        if (!hasOnlyDrinkabilityChecks || missingIds.length > 0) {
          const contractMsg =
            `Tool contract violation: drinkability queries must call check_drinking_window next for ${pendingDrinkabilityEntityIds.map((id) => `"${id}"`).join(', ')}.`;
          for (let bi = 0; bi < batchCalls.length; bi++) {
            state.toolOutcomes.push(
              buildToolOutcome(
                requestId,
                batchStepIndex,
                bi,
                batchCalls[bi]!.tool,
                contractMsg,
                null,
                batchDurationMs,
                true,
                false,
                false,
              ),
            );
          }
          state.steps.push({
            index: batchStepIndex,
            thought: parsed.thought,
            actionPairs: batchCalls.map((a) => ({ action: a, observation: contractMsg })),
            actions: batchCalls,
            observations: batchCalls.map(() => contractMsg),
            durationMs: batchDurationMs,
            tokenCount: { input: inputTokens, output: outputTokens },
          });
          return false;
        }
      }

      if (batchCalls.length > MAX_TOOLS_PER_BATCH) {
        state.reasoningFailureDetected = true;
        state.terminationReason = 'error';
        const truncatedActions = batchCalls.slice(0, MAX_TOOLS_PER_BATCH);
        const batchErrorMsg = `Batch too large: ${batchCalls.length} tools requested (max ${MAX_TOOLS_PER_BATCH}). Retry with fewer parallel calls.`;
        for (let bi = 0; bi < truncatedActions.length; bi++) {
          state.toolOutcomes.push(
            buildToolOutcome(
              requestId,
              batchStepIndex,
              bi,
              truncatedActions[bi]!.tool,
              batchErrorMsg,
              null,
              batchDurationMs,
              false,
              false,
              true,
            ),
          );
        }
        state.steps.push({
          index: batchStepIndex,
          thought: parsed.thought,
          actionPairs: truncatedActions.map((a) => ({ action: a, observation: batchErrorMsg })),
          actions: truncatedActions,
          observations: truncatedActions.map(() => batchErrorMsg),
          durationMs: batchDurationMs,
          tokenCount: { input: inputTokens, output: outputTokens },
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
        for (let bi = 0; bi < batchCalls.length; bi++) {
          state.toolOutcomes.push(
            buildToolOutcome(
              requestId,
              batchStepIndex,
              bi,
              batchCalls[bi]!.tool,
              unknownToolMsg,
              null,
              batchDurationMs,
              false,
              false,
              true,
            ),
          );
        }
        state.steps.push({
          index: batchStepIndex,
          thought: parsed.thought,
          actionPairs: batchCalls.map((a) => ({ action: a, observation: unknownToolMsg })),
          actions: batchCalls,
          observations: batchCalls.map(() => unknownToolMsg),
          durationMs: batchDurationMs,
          tokenCount: { input: inputTokens, output: outputTokens },
        });
        return false;
      }

      const effectiveBatchCalls = batchCalls.map((call) => {
        if (
          call.tool !== 'search_wines' ||
          !queryExecutionContract.hasEntityMetadataSignal
        ) {
          return call;
        }

        const searchQuery = call.input['query'];
        if (typeof searchQuery !== 'string' || !isSpecificSkuLikeQuery(searchQuery)) {
          return call;
        }

        return {
          ...call,
          input: normalizeExactMetadataSearchInput(call.input).effectiveInput,
        };
      });

      const batchPolicy = evaluateBatchPolicy(effectiveBatchCalls);
      if (!batchPolicy.allowed) {
        const policyReason = 'reason' in batchPolicy ? batchPolicy.reason : 'invalid_parallel_batch';
        const policyMsg = `Invalid parallel batch: ${policyReason}. Allowed: search_wines+search_wines/get_food_pairings, or check_drinking_window-only batches, or compare_wines alone.`;
        for (let bi = 0; bi < effectiveBatchCalls.length; bi++) {
          state.toolOutcomes.push(
            buildToolOutcome(
              requestId,
              batchStepIndex,
              bi,
              effectiveBatchCalls[bi]!.tool,
              policyMsg,
              null,
              batchDurationMs,
              false,
              false,
              true,
            ),
          );
        }
        state.steps.push({
          index: batchStepIndex,
          thought: parsed.thought,
          actionPairs: effectiveBatchCalls.map((a) => ({ action: a, observation: policyMsg })),
          actions: effectiveBatchCalls,
          observations: effectiveBatchCalls.map(() => policyMsg),
          durationMs: batchDurationMs,
          tokenCount: { input: inputTokens, output: outputTokens },
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
        if (isAbortError(batchErr)) {
          batchAbortController.abort();
          for (let bi = 0; bi < effectiveBatchCalls.length; bi++) {
            state.toolOutcomes.push(
              buildToolOutcome(
                requestId,
                state.steps.length,
                bi,
                effectiveBatchCalls[bi]!.tool,
                '[ABORTED] Request cancelled during parallel tool execution.',
                null,
                Math.max(0, Date.now() - stepStartMs),
                true,
                false,
                false,
              ),
            );
          }
          state.terminationReason = 'aborted';
          return true;
        }
        if ((batchErr as TimeoutErrorLike).code === 'TIMEOUT') {
          state.reasoningFailureDetected = true;
          state.timeoutStats.parallelBatch += 1;
          batchAbortController.abort();
          for (let bi = 0; bi < effectiveBatchCalls.length; bi++) {
            state.toolOutcomes.push(
              buildToolOutcome(
                requestId,
                state.steps.length,
                bi,
                effectiveBatchCalls[bi]!.tool,
                '[TIMEOUT] Parallel tool batch timed out.',
                null,
                Math.max(0, Date.now() - stepStartMs),
                false,
                true,
                false,
              ),
            );
          }
          state.terminationReason = 'timeout';
          return true;
        }
        if (batchErr instanceof DomainError && batchErr.code === POLICY_BLOCKED_CODE) {
          state.policyBlocked = true;
          state.terminationReason = 'blocked';
          batchAbortController.abort();
          const policyMsg = formatPolicyBlockedObservation(batchErr);
          for (let bi = 0; bi < effectiveBatchCalls.length; bi++) {
            state.toolOutcomes.push(
              buildToolOutcome(
                requestId,
                state.steps.length,
                bi,
                effectiveBatchCalls[bi]!.tool,
                policyMsg,
                null,
                Math.max(0, Date.now() - stepStartMs),
                false,
                false,
                true,
              ),
            );
          }
          state.steps.push({
            index: state.steps.length,
            thought: parsed.thought,
            actionPairs: effectiveBatchCalls.map((a) => ({ action: a, observation: policyMsg })),
            actions: effectiveBatchCalls,
            observations: effectiveBatchCalls.map(() => policyMsg),
            durationMs: Math.max(0, Date.now() - stepStartMs),
            tokenCount: { input: inputTokens, output: outputTokens },
          });
        } else {
          state.reasoningFailureDetected = true;
          state.terminationReason = 'error';
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
          buildToolOutcome(
            requestId,
            batchStepIndex,
            bi,
            call.tool,
            obs,
            result.rawResult,
            batchDurationMs,
            false,
            false,
            false,
          ),
        );
      }

      const remainingAfterBatch = effectiveConfig.maxSteps - budget.getStepCount();
      if (
        !state.hasInjectedRefinementHint &&
        remainingAfterBatch >= 3 &&
        observations.some((o) => o.includes('0개') || o.includes('검색 결과가 없습니다') || o.startsWith('NO_MATCH:'))
      ) {
        state.hasInjectedRefinementHint = true;
        state.pendingRefinementHint =
          'HINT: 이전 검색에서 결과가 없었습니다. 가장 제한적인 조건(가격/품종/지역)을 하나씩 완화하여 재검색하세요. 예: 가격 조건을 넓히거나 지역 조건을 제거하고 재검색.';
      }

      if (!await this.runContractDrinkabilityChecks(queryExecutionContract, requestId, effectiveConfig, budget, state, abortSignal)) {
        return true;
      }
      return false;
    }

    if (parsed.action !== undefined) {
      const { tool, input } = parsed.action;
      let effectiveInput = input;

      if (
        tool === 'search_wines' &&
        queryExecutionContract.hasEntityMetadataSignal
      ) {
        const searchQuery = input['query'];
        if (
          typeof searchQuery === 'string' &&
          isSpecificSkuLikeQuery(searchQuery)
        ) {
          effectiveInput = normalizeExactMetadataSearchInput(effectiveInput).effectiveInput;
          if (effectiveInput['limit'] !== 1) {
            effectiveInput = { ...effectiveInput, limit: 1 };
          }
        }
      }

      if (pendingDrinkabilityEntityIds.length > 0 && tool !== 'check_drinking_window') {
        const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
        const contractMsg =
          `Tool contract violation: drinkability queries must call check_drinking_window next for ${pendingDrinkabilityEntityIds.map((id) => `"${id}"`).join(', ')}.`;
        state.toolOutcomes.push(
          buildToolOutcome(
            requestId,
            state.steps.length,
            0,
            tool,
            contractMsg,
            null,
            stepDurationMs,
            true,
            false,
            false,
          ),
        );
        state.steps.push({
          index: state.steps.length,
          thought: parsed.thought,
          action: { tool, input: effectiveInput },
          observation: contractMsg,
          durationMs: stepDurationMs,
          tokenCount: { input: inputTokens, output: outputTokens },
        });
        return false;
      }

      if (!isKnownTool(tool)) {
        state.reasoningFailureDetected = true;
        state.unknownToolAttempts++;
        if (state.unknownToolAttempts > 2) {
          state.terminationReason = 'error';
          return true;
        }
        const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
        const unknownToolMsg = `Unknown tool: ${tool}. Available: search_wines, compare_wines, check_drinking_window, get_food_pairings`;
        state.toolOutcomes.push(
          buildToolOutcome(
            requestId,
            state.steps.length,
            0,
            tool,
            unknownToolMsg,
            null,
            stepDurationMs,
            false,
            false,
            true,
          ),
        );
        state.steps.push({
          index: state.steps.length,
          thought: parsed.thought,
          action: { tool, input: effectiveInput },
          observation: unknownToolMsg,
          durationMs: stepDurationMs,
          tokenCount: { input: inputTokens, output: outputTokens },
        });
        return false;
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
        if ((toolErr as TimeoutErrorLike).code === 'TIMEOUT') {
          state.timeoutStats.tool += 1;
          toolAbortController.abort();
          observation = `[TIMEOUT] Tool "${tool}" timed out. Try a different approach or a narrower query.`;
          rawResult = null;
          const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
          state.toolOutcomes.push(
            buildToolOutcome(
              requestId,
              state.steps.length,
              0,
              tool,
              observation,
              rawResult,
              stepDurationMs,
              false,
              true,
              false,
            ),
          );
          state.steps.push({
            index: state.steps.length,
            thought: parsed.thought,
            action: { tool, input: effectiveInput },
            observation,
            durationMs: stepDurationMs,
            tokenCount: { input: inputTokens, output: outputTokens },
          });
          return true;
        }
        if (isAbortError(toolErr)) {
          state.terminationReason = 'aborted';
          const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
          const abortedObservation = '[ABORTED] Request cancelled during tool execution.';
          state.toolOutcomes.push(
            buildToolOutcome(
              requestId,
              state.steps.length,
              0,
              tool,
              abortedObservation,
              null,
              stepDurationMs,
              true,
              false,
              false,
            ),
          );
          state.steps.push({
            index: state.steps.length,
            thought: parsed.thought,
            action: { tool, input: effectiveInput },
            observation: abortedObservation,
            durationMs: stepDurationMs,
            tokenCount: { input: inputTokens, output: outputTokens },
          });
          return true;
        }
        if (toolErr instanceof DomainError && toolErr.code === POLICY_BLOCKED_CODE) {
          state.policyBlocked = true;
          state.terminationReason = 'blocked';
          const stepDurationMs = Math.max(0, Date.now() - stepStartMs);
          const blockedObservation = formatPolicyBlockedObservation(toolErr);
          state.toolOutcomes.push(
            buildToolOutcome(
              requestId,
              state.steps.length,
              0,
              tool,
              blockedObservation,
              null,
              stepDurationMs,
              false,
              false,
              true,
            ),
          );
          state.steps.push({
            index: state.steps.length,
            thought: parsed.thought,
            action: { tool, input: effectiveInput },
            observation: blockedObservation,
            durationMs: stepDurationMs,
            tokenCount: { input: inputTokens, output: outputTokens },
          });
          return true;
        }
        observation = `Tool error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
        rawResult = null;
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
        buildToolOutcome(
          requestId,
          state.steps.length - 1,
          0,
          tool,
          observation,
          rawResult,
          stepDurationMs,
          rawResult === null,
          false,
          false,
        ),
      );

      const remainingStepsAfterTool = effectiveConfig.maxSteps - budget.getStepCount();
      if (
        !state.hasInjectedRefinementHint &&
        remainingStepsAfterTool >= 3 &&
        (observation.includes('0개') || observation.includes('검색 결과가 없습니다') || observation.startsWith('NO_MATCH:'))
      ) {
        state.hasInjectedRefinementHint = true;
        state.pendingRefinementHint =
          'HINT: 이전 검색에서 결과가 없었습니다. 가장 제한적인 조건(가격/품종/지역)을 하나씩 완화하여 재검색하세요. 예: 가격 조건을 넓히거나 지역 조건을 제거하고 재검색.';
      }

      if (!await this.runContractDrinkabilityChecks(queryExecutionContract, requestId, effectiveConfig, budget, state, abortSignal)) {
        return true;
      }
      return false;
    }

    return false;
  }

  async execute(
    query: string,
    requestId: string,
    overrides?: Partial<Pick<AgentConfig, 'maxSteps' | 'perStepTimeoutMs' | 'agentTimeoutMs'>>,
    abortSignal?: AbortSignal,
  ): Promise<AgentResult> {
    // Adaptive step budget — lexical classifier picks a tighter ceiling for
    // specific SKU lookups, adversarial probes, and off-domain queries.
    // Caller-supplied overrides win; classifier only fires when override
    // absent. Returns undefined for queries without a clear class, falling
    // back to this.config.maxSteps.
    // Empty query: return immediately without tool calls.
    if (query.trim().length === 0) {
      return {
        answer: '검색어를 입력해주세요. 어떤 와인을 찾고 계신가요?',
        steps: [],
        totalDurationMs: 0,
        totalTokens: { input: 0, output: 0 },
        toolCallCount: 0,
        fallbackApplied: false,
        terminationReason: 'answer',
      };
    }

    // Security pre-check: if a sanitizer is wired in, refuse injection/jailbreak/PII
    // queries immediately before any LLM or tool call. This ensures expectedBlocked
    // adversarial scenarios terminate with reason='blocked' and 0 tool calls.
    if (this.deps.querySanitizer !== undefined) {
      const sanitizeResult = this.deps.querySanitizer.sanitize(query);
      if (!sanitizeResult.safe) {
        log.info(
          { requestId, reason: (sanitizeResult as { readonly reason?: string }).reason },
          'Agent pre-check blocked query before LLM call',
        );
        return {
          answer: '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.',
          steps: [],
          totalDurationMs: 0,
          totalTokens: { input: 0, output: 0 },
          toolCallCount: 0,
          fallbackApplied: false,
          terminationReason: 'blocked',
        };
      }
    }


    const adaptive = overrides?.maxSteps === undefined ? classifyQueryBudget(query) : undefined;
    const queryExecutionContract = buildAgentQueryExecutionContract(query);
    const effectiveConfig = {
      ...this.config,
      ...(adaptive !== undefined ? { maxSteps: adaptive.maxSteps } : {}),
      ...(overrides ?? {}),
    };
    if (adaptive !== undefined) {
      log.info(
        { requestId, classification: adaptive.classification, maxSteps: adaptive.maxSteps, reason: adaptive.reason },
        'adaptive step budget applied',
      );
    }

    const budget = new StepBudget(effectiveConfig);
    const state = this.createExecutionState();

    try {
      for (;;) {
        const budgetCheck = budget.canProceed();
        if (!budgetCheck.allowed) {
          state.terminationReason = budgetCheck.reason ?? 'max_steps';
          break;
        }

        const remainingSteps = effectiveConfig.maxSteps - budget.getStepCount();
        const hasToolHistory = state.steps.length > 0;
        const isLastStep = remainingSteps === 1 || (remainingSteps === 2 && hasToolHistory);

        if (state.totalInputTokens + state.totalOutputTokens >= effectiveConfig.maxTotalTokens) {
          log.info(
            { requestId, totalTokens: state.totalInputTokens + state.totalOutputTokens, budget: effectiveConfig.maxTotalTokens },
            'agent token budget exhausted before LLM call — terminating',
          );
          state.terminationReason = 'budget';
          break;
        }

        if (abortSignal?.aborted) {
          state.terminationReason = 'error';
          break;
        }

        const plannerPhase = await this.plannerPhaseRunner.run(
          query,
          requestId,
          effectiveConfig,
          state,
          remainingSteps,
          isLastStep,
          abortSignal,
        );
        if (plannerPhase === null) {
          break;
        }

        const shouldBreak = await this.runStepExecutorPhase(
          requestId,
          effectiveConfig,
          budget,
          state,
          queryExecutionContract,
          plannerPhase,
          abortSignal,
        );
        if (shouldBreak) {
          break;
        }
      }
    } catch (err) {
      log.error({ err, requestId }, 'Agent orchestrator unexpected error');
      if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
        state.policyBlocked = true;
        state.terminationReason = 'blocked';
      } else if (err instanceof DomainError && err.code === CIRCUIT_BREAKER_OPEN_CODE) {
        state.reasoningFailureDetected = true;
        state.llmCircuitOpen = true;
        state.terminationReason = 'error';
      } else {
        state.reasoningFailureDetected = true;
        state.terminationReason = 'error';
      }
    }

    if (!state.policyBlocked && !state.llmCircuitOpen && state.answer === '' && state.terminationReason !== 'answer' && !(abortSignal?.aborted)) {
      await this.observationSynthesisRunner.run(query, requestId, effectiveConfig, state, abortSignal);
    }

    const observedToolOutput = hasToolObservations(state);
    const answer = await this.fallbackFinalizer.runFallbackCascade(query, requestId, state, observedToolOutput, abortSignal);

    log.info(
      {
        requestId,
        steps: state.steps.length,
        toolCalls: state.steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actionPairs?.length ?? 0), 0),
        terminationReason: state.terminationReason,
        timeoutStats: state.timeoutStats,
        failureTags: [
          ...(state.timeoutStats.llmStep > 0 ? ['llm_step_timeout'] : []),
          ...(state.timeoutStats.parallelBatch > 0 ? ['parallel_batch_timeout'] : []),
          ...(state.timeoutStats.tool > 0 ? ['tool_timeout'] : []),
        ],
        totalDurationMs: budget.getElapsedMs(),
        fallbackApplied: state.fallbackApplied,
      },
      'Agent execution complete',
    );

    this.deps.executionObserver?.onExecutionComplete({
      terminationReason: state.terminationReason,
      fallbackApplied: state.fallbackApplied,
      toolCallCount: state.steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actionPairs?.length ?? 0), 0),
      totalDurationMs: budget.getElapsedMs(),
      timeoutStats: state.timeoutStats,
      synthesis: {
        reasoningFailure:
          state.reasoningFailureDetected ||
          state.timeoutStats.llmStep > 0 ||
          state.timeoutStats.parallelBatch > 0 ||
          state.llmCircuitOpen ||
          state.failedSynthesisAttempts > 0 ||
          (observedToolOutput && state.fallbackLayer !== null),
        fallbackApplied: state.fallbackLayer,
      },
    });

    const reasoningFailure =
      state.reasoningFailureDetected ||
      state.timeoutStats.llmStep > 0 ||
      state.timeoutStats.parallelBatch > 0 ||
      state.llmCircuitOpen ||
      state.failedSynthesisAttempts > 0 ||
      (observedToolOutput && state.fallbackLayer !== null);
    const synthesisContext = buildSynthesisContext(
      query,
      state.toolOutcomes,
      reasoningFailure,
      state.fallbackLayer,
    );

    return {
      answer: answer.trim(),
      steps: state.steps,
      totalDurationMs: budget.getElapsedMs(),
      totalTokens: { input: state.totalInputTokens, output: state.totalOutputTokens },
      toolCallCount: state.steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actionPairs?.length ?? 0), 0),
      fallbackApplied: state.fallbackApplied,
      terminationReason: state.terminationReason,
      ...(state.lastSearchResult !== undefined ? { searchResults: state.lastSearchResult } : {}),
      ...(state.toolOutcomes.length > 0 ? { toolOutcomes: state.toolOutcomes } : {}),
      ...(state.collectedFrames.length > 0 ? { evidenceFrames: state.collectedFrames } : {}),
      synthesisContext,
      ...(state.fallbackApplied
        ? {
            fallbackTrace: {
              fallbackApplied: state.fallbackLayer,
              reasoningFailure,
              failedSynthesisAttempts: state.failedSynthesisAttempts,
              fallbackSearchUsed: state.fallbackSearchUsed,
            },
          }
        : {}),
    };
  }
}
