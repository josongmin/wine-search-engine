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

import type { ChatLlmPort, ChatMessage } from '../../domain/ai/port/chat-llm.port.js';
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
  buildPlannerSystemMessage,
  buildSynthesisSystemMessage,
  buildUserMessage,
  buildStepMessages,
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
  type SynthesisContext,
  type ToolOutcome,
  type ToolOutcomeKind,
} from './tool-outcome.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { containsHangul } from '../../domain/shared/utils/hangul.js';
import { isAbortError } from '../../domain/shared/cooperative-abort.js';
import type { AgentExecutionObserver } from '../../domain/agent/port/agent-execution-observer.port.js';
import { QueryNormalizer } from '../../domain/query/service/query-normalizer.js';
import {
  hasDrinkabilityKeyword,
  hasEntityMetadataKeyword,
} from '../../domain/query/service/planner-intent-detection.js';
import { PolicyBlockedError } from '../../domain/shared/error/policy-blocked.js';

const log = bootstrapLogger.child({ component: 'AgentOrchestrator' });

/** Wall-clock budget for the observation-based synthesis LLM call (Layer 1 fallback).
 * gpt-4o averages 20-30s per call; 12s caused consistent timeouts. */
const SYNTHESIS_TIMEOUT_MS = 60_000;
/** Wall-clock budget for the Layer 2 single-shot fallback search. */
const FALLBACK_SEARCH_TIMEOUT_MS = 5_000;
/** First synthesis attempt: full token budget (allows detailed, well-structured answers). */
const SYNTHESIS_TOKENS_ATTEMPT_1 = 512;
/** Second synthesis attempt: halved budget — fast path when first attempt times out. */
const SYNTHESIS_TOKENS_ATTEMPT_2 = 256;
/** Layer 3 fallback: max chars of observation to include in answer (prevents oversized responses). */
const LAYER3_OBSERVATION_SLICE_CHARS = 300;
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
const LOG_PREVIEW_CHARS = 200;

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

interface PlannerPhaseResult {
  readonly stepStartMs: number;
  readonly parsed: LlmAction;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly wasTruncated: boolean;
}

interface AgentExecutionState {
  readonly steps: AgentStep[];
  readonly toolOutcomes: ToolOutcome[];
  readonly collectedFrames: ToolCallEvidenceFrame[];
  lastSearchResult: SearchResponseV1 | undefined;
  terminationReason: AgentTerminationReason;
  totalInputTokens: number;
  totalOutputTokens: number;
  reasoningFailureDetected: boolean;
  policyBlocked: boolean;
  llmCircuitOpen: boolean;
  unknownToolAttempts: number;
  timeoutStats: { llmStep: number; tool: number; parallelBatch: number };
  hasInjectedRefinementHint: boolean;
  pendingRefinementHint: string | undefined;
  fallbackApplied: boolean;
  fallbackLayer: SynthesisContext['fallbackApplied'];
  failedSynthesisAttempts: number;
  fallbackSearchUsed: boolean;
  answer: string;
}

function buildPlannerLoopMessages(
  query: string,
  steps: readonly AgentStep[],
  pendingRefinementHint: string | undefined,
  isLastStep: boolean,
  remainingSteps: number,
  maxContextChars: number,
): readonly ChatMessage[] {
  const baseUserContentRaw = pendingRefinementHint !== undefined
    ? `${pendingRefinementHint}\n\n${query}`
    : query;
  const baseUserContent = baseUserContentRaw.length > maxContextChars
    ? baseUserContentRaw.slice(0, maxContextChars)
    : baseUserContentRaw;
  const messages = [
    buildPlannerSystemMessage(),
    buildUserMessage(baseUserContent),
    ...buildStepMessages(steps),
  ];
  if (isLastStep) {
    messages.push({
      role: 'user',
      content: remainingSteps === 1
        ? `[LAST_STEP] Step budget exhausted. You MUST produce a final {"thought":"…","answer":"…"} JSON now using the information above. Do NOT call another tool.`
        : `[BUDGET_WARNING] Only ${remainingSteps} steps remain. Synthesize your current search results into a final {"thought":"…","answer":"…"} NOW — do not call another tool unless you have no results yet.`,
    });
  }
  return messages;
}

interface ObservationSynthesisMessages {
  readonly messages: readonly ChatMessage[];
  readonly sentinel: string;
}

function buildObservationSynthesisMessages(
  query: string,
  steps: readonly AgentStep[],
  requestId: string,
): ObservationSynthesisMessages {
  const synthSentinel = `[SYSTEM:${requestId}:FINAL_ANSWER_REQUIRED]\nYou have exhausted your step budget. Synthesize the tool results above into a final answer now.\nOutput ONLY this JSON — no other text, no code fences:\n{"thought":"one-sentence summary of findings","answer":"your complete, grounded response in the user's language (Korean if query was Korean)"}\nRules:\n- "answer" must reference specific wines, regions, or prices from the tool results above.\n- Do NOT call any tool. Do NOT output "action" or "actions".\n- If results were empty, tell the user no match was found and suggest broadening the search.`;
  return {
    messages: [
      buildSynthesisSystemMessage(),
      buildUserMessage(query),
      ...buildStepMessages(steps),
      {
        role: 'user',
        content: synthSentinel,
      },
    ],
    sentinel: synthSentinel,
  };
}


/** Longer log-preview chars for step-level debug output (more context than error previews). */
const STEP_LOG_PREVIEW_CHARS = 500;
/** Rough estimate: 4 characters ≈ 1 LLM token (for budget tracking only, not billing). */
const CHARS_PER_TOKEN_ESTIMATE = 4;
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

/** Parsed LLM output — either a tool call, a parallel batch, or a final answer. */
interface LlmAction {
  readonly thought: string;
  // Sequential single tool call
  readonly action?: { readonly tool: string; readonly input: Record<string, unknown> };
  // Parallel batch: LLM emits {"thought":"…","actions":[{tool,input},{tool,input}]}
  readonly actions?: readonly { readonly tool: string; readonly input: Record<string, unknown> }[];
  readonly answer?: string;
}

interface TimeoutErrorLike extends Error {
  readonly code?: string;
}

function isValidLlmResult(value: unknown): value is { text: string; model: string; finishReason?: string | null } {
  if (typeof value !== 'object' || value === null) return false;
  const rec = value as Record<string, unknown>;
  return typeof rec['text'] === 'string' && typeof rec['model'] === 'string';
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

/**
 * Extract the first complete JSON object from a string that may contain multiple
 * concatenated JSON objects. gpt-5.4 series sometimes emits two objects back-to-back:
 * the valid action object followed by a premature "I have no results" continuation.
 * JSON.parse throws SyntaxError on the full string, losing the valid action entirely.
 * This walks character by character tracking brace depth and stops at the closing `}`
 * of the first top-level object. Falls back to the full string if no object is found.
 */
function extractFirstJsonObject(text: string): string {
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) return text.slice(start, i + 1);
    }
  }
  return text; // fallback: no complete object found, let JSON.parse fail naturally
}

/**
 * Recover the most recent search_wines input from the agent's step history.
 * Used by Layer 2 fallback to preserve constraints from failed/aborted attempts.
 *
 * Walks the steps in reverse order, returning the input of the last `search_wines`
 * action found (in either the legacy `action` field or the parallel `actionPairs`
 * field). Returns undefined if no search_wines was ever attempted.
 *
 * Returns the validated subset that searchUseCase needs (currently `query` only —
 * extending this to forward `wine_type`, `country`, `vintage_min/max`, `max_price_krw`
 * etc. requires changing searchUseCase to accept structured constraints in addition
 * to the NL query, which is a separate refactor).
 */
function recoverLastSearchInput(steps: readonly AgentStep[]): { query: string } | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    // Check parallel actionPairs first (newer format)
    if (step.actionPairs !== undefined) {
      for (let j = step.actionPairs.length - 1; j >= 0; j--) {
        const pair = step.actionPairs[j]!;
        if (pair.action.tool === 'search_wines') {
          const q = pair.action.input['query'];
          if (typeof q === 'string' && q.trim().length > 0) return { query: q };
        }
      }
    }
    // Check legacy single action (migration fallback: actionPairs is preferred; action is the deprecated path)
    // TODO(cleanup): remove after actionPairs migration complete
    if (step.action?.tool === 'search_wines') {
      const q = step.action.input['query'];
      if (typeof q === 'string' && q.trim().length > 0) return { query: q };
    }
  }
  return undefined;
}

function parseLlmOutput(text: string): LlmAction {
  try {
    const trimmed = text.trim();
    const cleaned = trimmed
      .replace(/^```[\w-]*\s*\n?/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    // Extract only the first JSON object — gpt-5.4 series occasionally emits two
    // back-to-back objects which causes JSON.parse to throw and lose the valid action.
    const firstObject = extractFirstJsonObject(cleaned);
    const rawParsed: unknown = JSON.parse(firstObject);
    if (typeof rawParsed !== 'object' || rawParsed === null) {
      return { thought: text.slice(0, LOG_PREVIEW_CHARS) };
    }
    const parsed = rawParsed as Record<string, unknown>;

    const thought = typeof parsed['thought'] === 'string' ? parsed['thought'] : '';

    if (typeof parsed['answer'] === 'string') {
      return { thought, answer: parsed['answer'] };
    }

    // Parallel batch: {"thought":"…","actions":[{tool,input},…]}
    // Validate each entry; silently drop malformed entries.
    // If the LLM emits input as a string (e.g. {"tool":"search_wines","input":"opus one"})
    // instead of an object, coerce it to {query: string} so the tool receives the
    // query intent rather than an empty object that produces empty-query errors.
    const actionsRaw = parsed['actions'];
    if (Array.isArray(actionsRaw) && actionsRaw.length > 0) {
      const validActions = (actionsRaw as unknown[])
        .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
        .map((a) => ({
          tool: typeof a['tool'] === 'string' ? a['tool'] : '',
          input:
            typeof a['input'] === 'object' && a['input'] !== null
              ? (a['input'] as Record<string, unknown>)
              : typeof a['input'] === 'string' && a['input'].length > 0
                ? { query: a['input'] }
                : {},
        }))
        .filter((a) => a.tool.length > 0);
      if (validActions.length > 0) {
        return { thought, actions: validActions };
      }
    }

    // Single tool call (sequential)
    const rawAction = parsed['action'];
    const action =
      typeof rawAction === 'object' && rawAction !== null && !Array.isArray(rawAction)
        ? (rawAction as Record<string, unknown>)
        : undefined;
    if (action !== undefined && typeof action['tool'] === 'string' && action['tool'].length > 0) {
      const input =
        typeof action['input'] === 'object' && action['input'] !== null
          ? (action['input'] as Record<string, unknown>)
          : typeof action['input'] === 'string' && action['input'].length > 0
            ? { query: action['input'] }
            : {};
      return { thought, action: { tool: action['tool'], input } };
    }

    // Bare tool call: LLM emitted {"tool":"search_wines","input":{…}} without wrapping in "action".
    // Recover by treating the top-level object itself as the action.
    if (typeof parsed['tool'] === 'string' && parsed['tool'].length > 0) {
      const bareInput =
        typeof parsed['input'] === 'object' && parsed['input'] !== null
          ? (parsed['input'] as Record<string, unknown>)
          : typeof parsed['input'] === 'string' && parsed['input'].length > 0
            ? { query: parsed['input'] }
            : {};
      log.warn(
        { tool: parsed['tool'], textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
        'agent LLM emitted bare tool call (missing action wrapper); recovered',
      );
      return { thought, action: { tool: parsed['tool'], input: bareInput } };
    }

    // If neither action/actions nor answer, treat the whole text as an answer.
    log.warn(
      { textPreview: trimmed.slice(0, LOG_PREVIEW_CHARS) },
      'agent LLM produced JSON without action or answer; falling back to raw text',
    );
    return { thought: '[unparseable LLM structure]', answer: trimmed };
  } catch {
    log.warn(
      { textPreview: text.slice(0, LOG_PREVIEW_CHARS) },
      'agent LLM produced non-JSON output; falling back to raw text',
    );
    return { thought: '[unparseable LLM output]', answer: text.trim() };
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

  constructor(
    private readonly deps: AgentOrchestratorDeps,
    config?: Partial<AgentConfig>,
  ) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config };
  }

  private createExecutionState(): AgentExecutionState {
    return {
      steps: [],
      toolOutcomes: [],
      collectedFrames: [],
      lastSearchResult: undefined,
      terminationReason: 'max_steps',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      reasoningFailureDetected: false,
      policyBlocked: false,
      llmCircuitOpen: false,
      unknownToolAttempts: 0,
      timeoutStats: { llmStep: 0, tool: 0, parallelBatch: 0 },
      hasInjectedRefinementHint: false,
      pendingRefinementHint: undefined,
      fallbackApplied: false,
      fallbackLayer: null,
      failedSynthesisAttempts: 0,
      fallbackSearchUsed: false,
      answer: '',
    };
  }

  private async runPlannerPhase(
    query: string,
    requestId: string,
    effectiveConfig: AgentConfig,
    state: AgentExecutionState,
    remainingSteps: number,
    isLastStep: boolean,
    abortSignal?: AbortSignal,
  ): Promise<PlannerPhaseResult | null> {
    const stepStartMs = Date.now();
    const messages = buildPlannerLoopMessages(
      query,
      state.steps,
      state.pendingRefinementHint,
      isLastStep,
      remainingSteps,
      effectiveConfig.maxContextChars,
    );
    state.pendingRefinementHint = undefined;

    if (abortSignal?.aborted) {
      state.terminationReason = 'error';
      return null;
    }

    const stepAbortController = new AbortController();
    const propagateAbort = (): void => { stepAbortController.abort(); };
    abortSignal?.addEventListener('abort', propagateAbort, { once: true });
    if (abortSignal?.aborted) {
      abortSignal.removeEventListener('abort', propagateAbort);
      state.terminationReason = 'error';
      return null;
    }

    let stepTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let llmResult: { text: string; model: string; finishReason?: string | null };
    try {
      const racedResult: unknown = await Promise.race([
        this.deps.chatLlm.complete({
          messages,
          temperature: 0,
          maxOutputTokens: 2048,
          ...(effectiveConfig.seed !== undefined ? { seed: effectiveConfig.seed } : {}),
          abortSignal: stepAbortController.signal,
        }),
        new Promise<never>((_resolve, reject) => {
          stepTimeoutHandle = setTimeout(
            () => {
              stepAbortController.abort();
              reject(new Error('Agent LLM step timed out'));
            },
            effectiveConfig.perStepTimeoutMs,
          );
        }),
      ]);
      if (!isValidLlmResult(racedResult)) {
        log.warn(
          { requestId, stepIndex: state.steps.length, rawType: typeof racedResult },
          'Agent LLM returned malformed step result',
        );
        state.reasoningFailureDetected = true;
        state.terminationReason = 'error';
        return null;
      }
      llmResult = racedResult;
    } catch (err) {
      log.warn({ err, requestId, stepIndex: state.steps.length }, 'Agent LLM call failed');
      if (isAbortError(err)) {
        state.terminationReason = 'aborted';
      } else if ((err as Error).message === 'Agent LLM step timed out') {
        state.reasoningFailureDetected = true;
        state.timeoutStats.llmStep += 1;
        state.terminationReason = 'timeout';
      } else if (err instanceof DomainError && err.code === CIRCUIT_BREAKER_OPEN_CODE) {
        state.reasoningFailureDetected = true;
        state.llmCircuitOpen = true;
        state.terminationReason = 'error';
      } else {
        state.reasoningFailureDetected = true;
        state.terminationReason = 'error';
      }
      return null;
    } finally {
      abortSignal?.removeEventListener('abort', propagateAbort);
      if (stepTimeoutHandle !== undefined) {
        clearTimeout(stepTimeoutHandle);
      }
    }

    const wasTruncated = llmResult.finishReason === 'length';
    if (wasTruncated) {
      log.warn({ requestId, stepIndex: state.steps.length }, 'Agent LLM output truncated (finish_reason=length) — attempting recovery');
    }

    const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN_ESTIMATE);
    const outputTokens = Math.ceil(llmResult.text.length / CHARS_PER_TOKEN_ESTIMATE);
    state.totalInputTokens += inputTokens;
    state.totalOutputTokens += outputTokens;

    if (state.totalInputTokens + state.totalOutputTokens >= effectiveConfig.maxTotalTokens) {
      log.warn(
        { requestId, totalTokens: state.totalInputTokens + state.totalOutputTokens, budget: effectiveConfig.maxTotalTokens },
        'agent token budget exceeded — terminating',
      );
      state.terminationReason = 'budget';
      return null;
    }

    const parsed = parseLlmOutput(llmResult.text);
    if (state.steps.length === 0) {
      log.info(
        {
          requestId,
          textPreview: llmResult.text.slice(0, STEP_LOG_PREVIEW_CHARS),
          finishReason: llmResult.finishReason,
          hasAction: parsed.action !== undefined,
          hasActions: parsed.actions !== undefined,
          hasAnswer: parsed.answer !== undefined && parsed.answer.length > 0,
          wasTruncated,
        },
        '[RCA] step0 LLM output',
      );
    }

    return {
      stepStartMs,
      parsed,
      inputTokens,
      outputTokens,
      wasTruncated,
    };
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

  private async runObservationSynthesisPhase(
    query: string,
    requestId: string,
    effectiveConfig: AgentConfig,
    state: AgentExecutionState,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (state.totalInputTokens + state.totalOutputTokens >= effectiveConfig.maxTotalTokens) {
      log.warn({ requestId, totalInputTokens: state.totalInputTokens, totalOutputTokens: state.totalOutputTokens, budget: effectiveConfig.maxTotalTokens }, '[agent] token budget exhausted — skipping final answer synthesis to prevent overrun');
      return;
    }

    const obsSteps = state.steps.filter(
      (s) =>
        (s.observation !== undefined && s.observation.length > 0) ||
        (s.actionPairs !== undefined && s.actionPairs.some((p) => p.observation.length > 0)),
    );
    if (obsSteps.length === 0) {
      return;
    }

    const { messages: synthMessages, sentinel: synthSentinel } = buildObservationSynthesisMessages(query, state.steps, requestId);
    const attemptSynthesis = async (maxOutputTokens: number): Promise<string | undefined> => {
      if (abortSignal?.aborted) return undefined;
      const synthAbort = new AbortController();
      const propagateSynthAbort = (): void => { synthAbort.abort(); };
      abortSignal?.addEventListener('abort', propagateSynthAbort, { once: true });
      if (abortSignal?.aborted) {
        synthAbort.abort();
        abortSignal.removeEventListener('abort', propagateSynthAbort);
        return undefined;
      }
      const synthTimer = setTimeout(() => {
        synthAbort.abort();
      }, SYNTHESIS_TIMEOUT_MS);
      try {
        const synthResult = await this.deps.chatLlm.complete({
          messages: synthMessages,
          temperature: 0,
          maxOutputTokens,
          ...(effectiveConfig.seed !== undefined ? { seed: effectiveConfig.seed } : {}),
          abortSignal: synthAbort.signal,
        });
        if (!isValidLlmResult(synthResult)) {
          log.warn({ requestId }, 'synthesis LLM returned malformed result');
          return undefined;
        }
        state.totalInputTokens += Math.ceil(synthSentinel.length / CHARS_PER_TOKEN_ESTIMATE);
        state.totalOutputTokens += Math.ceil(synthResult.text.length / CHARS_PER_TOKEN_ESTIMATE);
        const parsedSynth = parseLlmOutput(synthResult.text);
        if (parsedSynth.action !== undefined || parsedSynth.actions !== undefined) {
          log.warn({ requestId }, 'synthesis LLM returned tool call — ignoring, falling to next layer');
          return undefined;
        }
        const candidate = parsedSynth.answer?.trim() ?? '';
        const isShell = /^[{[\s]*[}\]]*$/.test(candidate);
        return candidate.length > 10 && !isShell ? candidate : undefined;
      } finally {
        abortSignal?.removeEventListener('abort', propagateSynthAbort);
        clearTimeout(synthTimer);
      }
    };

    let synthAnswer: string | undefined;
    try {
      synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_1);
    } catch (synthErr1) {
      if (synthErr1 instanceof DomainError && synthErr1.code === CIRCUIT_BREAKER_OPEN_CODE) {
        state.llmCircuitOpen = true;
      } else if (isAbortError(synthErr1)) {
        state.terminationReason = 'aborted';
      }
      // synthesis attempt threw -> keep this on the error channel only
      log.error({ err: synthErr1, requestId }, `synthesis retry attempt 1 failed (timeout/error) — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
    }
    if (synthAnswer === undefined) {
      state.failedSynthesisAttempts += 1;
    }
    if (
      synthAnswer === undefined &&
      !(abortSignal?.aborted) &&
      !state.llmCircuitOpen &&
      state.totalInputTokens + state.totalOutputTokens < effectiveConfig.maxTotalTokens
    ) {
      try {
        log.info({ requestId, obsSteps: obsSteps.length }, `synthesis attempt 1 returned empty — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
        synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_2);
      } catch (synthErr2) {
        if (synthErr2 instanceof DomainError && synthErr2.code === CIRCUIT_BREAKER_OPEN_CODE) {
          state.llmCircuitOpen = true;
        } else if (isAbortError(synthErr2)) {
          state.terminationReason = 'aborted';
        }
        // synthesis attempt threw -> keep this on the error channel only
        log.error({ err: synthErr2, requestId }, 'synthesis retry attempt 2 failed — proceeding to fallback search');
      }
      if (synthAnswer === undefined) {
        state.failedSynthesisAttempts += 1;
      }
    }
    if (synthAnswer !== undefined) {
      state.answer = synthAnswer;
      state.terminationReason = 'answer';
      log.info({ requestId, obsSteps: obsSteps.length }, 'synthesized answer from observations');
    }
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

        const plannerPhase = await this.runPlannerPhase(
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
      await this.runObservationSynthesisPhase(query, requestId, effectiveConfig, state, abortSignal);
    }

    let fallbackApplied = false;
    let fallbackLayer: SynthesisContext['fallbackApplied'] = null;
    let fallbackSearchUsed = false;
    let answer = state.answer;

    const hasToolObservations = state.steps.some(
      (s) =>
        (s.observation !== undefined && s.observation.length > 0) ||
        (s.actionPairs !== undefined && s.actionPairs.some((p) => p.observation.length > 0)),
    );

    const shouldRunLayer2Fallback =
      !state.policyBlocked &&
      answer === '' &&
      state.terminationReason !== 'answer' &&
      !hasToolObservations &&
      !(abortSignal?.aborted);

    if (shouldRunLayer2Fallback) {
      const fallbackController = new AbortController();
      const propagateFallbackAbort = (): void => { fallbackController.abort(); };
      abortSignal?.addEventListener('abort', propagateFallbackAbort, { once: true });
      const fallbackTimer = setTimeout(() => {
        fallbackController.abort();
      }, FALLBACK_SEARCH_TIMEOUT_MS);
      try {
        const lastSearchInput = recoverLastSearchInput(state.steps);
        const fallbackQuery = lastSearchInput?.query ?? query;
        const fallbackResult = await this.deps.toolDeps.searchUseCase.execute(
          { query: fallbackQuery },
          requestId + '-fallback',
          { abortSignal: fallbackController.signal },
        );
        fallbackSearchUsed = true;
        const topResult = fallbackResult.queryType === 'search' ? fallbackResult.results.at(0) : undefined;
        if (topResult !== undefined) {
          const producer = topResult.entity.producer ?? '';
          const region = topResult.entity.region ?? '';
          const detail = [producer, region].filter(Boolean).join(', ');
          const queryHasHangul = containsHangul(query);
          answer = queryHasHangul
            ? '검색 결과: ' + topResult.entity.canonicalLabel + (detail ? ' (' + detail + ')' : '') + '. (참고: 처리 제약으로 간단히 표시되었습니다.)'
            : 'Based on your query, I found: ' + topResult.entity.canonicalLabel + (detail ? ' (' + detail + ')' : '') + '. (Note: simplified result due to processing constraints.)';
          state.answer = answer;
          state.lastSearchResult = fallbackResult.queryType === 'search' ? fallbackResult : undefined;
          fallbackApplied = true;
          fallbackLayer = 'layer2';
          state.fallbackLayer = fallbackLayer;
          state.terminationReason = 'fallback';
        } else {
          const queryHasHangul = containsHangul(query);
          answer = queryHasHangul
            ? '"' + query + '"에 대한 검색 결과를 찾지 못했습니다. 검색어를 더 간단하게 바꾸거나 다른 와인명이나 품종으로 다시 시도해보세요.'
            : 'No results found for "' + query + '". Try simplifying the query or using a different wine name or grape variety.';
          state.answer = answer;
          fallbackApplied = true;
          fallbackLayer = 'layer2';
          state.fallbackLayer = fallbackLayer;
          state.terminationReason = 'fallback';
        }
      } catch (err) {
        if (isAbortError(err)) {
          state.terminationReason = 'aborted';
        } else {
          log.error({ err, requestId }, 'agent fallback search failed');
        }
      } finally {
        abortSignal?.removeEventListener('abort', propagateFallbackAbort);
        clearTimeout(fallbackTimer);
      }
    }

    if (!state.policyBlocked && state.terminationReason !== 'aborted' && answer === '') {
      const lastObs = state.steps.findLast(
        (s) =>
          (s.observation !== undefined && s.observation.length > 0) ||
          (s.actionPairs !== undefined && s.actionPairs.some((p) => p.observation.length > 0)),
      );
      const lastObsText =
        lastObs?.observation ??
        lastObs?.actionPairs?.find((p) => p.observation.length > 0)?.observation;
      if (lastObsText !== undefined) {
        const queryHasHangul = containsHangul(query);
        const preview = lastObsText.slice(0, LAYER3_OBSERVATION_SLICE_CHARS);
        answer = queryHasHangul
          ? '검색 결과 요약: ' + preview
          : 'Search result summary: ' + preview;
        state.answer = answer;
        fallbackApplied = true;
        fallbackLayer = 'layer3';
        state.fallbackLayer = fallbackLayer;
        state.terminationReason = hasToolObservations ? 'answer' : 'fallback';
        log.error({ requestId, hasToolObservations }, 'Layer 3 fallback: all LLM synthesis paths failed — using raw observation');
      }
    }

    if (state.policyBlocked && answer === '') {
      answer = '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.';
      state.answer = answer;
      log.error({ requestId }, 'policy-blocked agent run ended without explicit answer; returning blocked template');
    }

    // Layer 4: absolute guarantee — return a non-empty Korean answer template.
    // Layer 4 fallback template: keep the literal assignment directly below this comment.
    if (!state.policyBlocked && state.terminationReason !== 'aborted' && answer === '') {
      answer = '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.';
      state.answer = answer;
      fallbackApplied = true;
      fallbackLayer = 'layer4';
      state.fallbackLayer = fallbackLayer;
      state.terminationReason = hasToolObservations ? 'answer' : 'fallback';
      log.error({ requestId, query, steps: state.steps.length }, 'Layer 4 fallback: all synthesis paths exhausted — returning template answer');
    }

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
        fallbackApplied,
      },
      'Agent execution complete',
    );

    this.deps.executionObserver?.onExecutionComplete({
      terminationReason: state.terminationReason,
      fallbackApplied,
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
          (hasToolObservations && fallbackLayer !== null),
        fallbackApplied: fallbackLayer,
      },
    });

    const reasoningFailure =
      state.reasoningFailureDetected ||
      state.timeoutStats.llmStep > 0 ||
      state.timeoutStats.parallelBatch > 0 ||
      state.llmCircuitOpen ||
      state.failedSynthesisAttempts > 0 ||
      (hasToolObservations && fallbackLayer !== null);
    const synthesisContext = buildSynthesisContext(
      query,
      state.toolOutcomes,
      reasoningFailure,
      fallbackLayer,
    );

    return {
      answer: answer.trim(),
      steps: state.steps,
      totalDurationMs: budget.getElapsedMs(),
      totalTokens: { input: state.totalInputTokens, output: state.totalOutputTokens },
      toolCallCount: state.steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actionPairs?.length ?? 0), 0),
      fallbackApplied,
      terminationReason: state.terminationReason,
      ...(state.lastSearchResult !== undefined ? { searchResults: state.lastSearchResult } : {}),
      ...(state.toolOutcomes.length > 0 ? { toolOutcomes: state.toolOutcomes } : {}),
      ...(state.collectedFrames.length > 0 ? { evidenceFrames: state.collectedFrames } : {}),
      synthesisContext,
      ...(fallbackApplied
        ? {
            fallbackTrace: {
              fallbackApplied: fallbackLayer,
              reasoningFailure,
              failedSynthesisAttempts: state.failedSynthesisAttempts,
              fallbackSearchUsed,
            },
          }
        : {}),
    };
  }
}
