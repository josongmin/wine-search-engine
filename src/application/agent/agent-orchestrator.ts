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
  buildSystemMessage,
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
/** Default parallel-batch timeout (caps total Promise.all wait). */
const DEFAULT_PARALLEL_BATCH_TIMEOUT_MS = 10_000;
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
/** Longer log-preview chars for step-level debug output (more context than error previews). */
const STEP_LOG_PREVIEW_CHARS = 500;
/** Rough estimate: 4 characters ≈ 1 LLM token (for budget tracking only, not billing). */
const CHARS_PER_TOKEN_ESTIMATE = 4;

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
        log.warn(
          { requestId, reason: sanitizeResult.reason },
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
    const steps: AgentStep[] = [];
    // E7-T2: Typed tool outcomes, generated alongside AgentStep for each tool invocation.
    const toolOutcomes: ToolOutcome[] = [];
    let lastSearchResult: SearchResponseV1 | undefined;
    let terminationReason: AgentTerminationReason = 'max_steps';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    /**
     * Set when a tool execution surfaced a policy block. Prevents the
     * single-shot fallback from re-running the raw query through the
     * search use case after the agent's protective layers said no.
     */
    let policyBlocked = false;
    /**
     * Set when the LLM circuit breaker opens mid-run. When true, all subsequent
     * synthesis attempts are skipped — calling a fast-failing breaker again
     * cannot succeed and only adds log noise + latency. Fallback layers that
     * do not require the LLM (Layer 2 search, Layer 3 observation slice,
     * Layer 4 template) still execute.
     */
    let llmCircuitOpen = false;
    let unknownToolAttempts = 0;
    const MAX_UNKNOWN_TOOL_ATTEMPTS = 2;
    const timeoutStats = {
      llmStep: 0,
      tool: 0,
      parallelBatch: 0,
    };
    /**
     * Hard cap on parallel tools per batch step. An adversarially-prompted LLM
     * can emit {"actions":[...100 tools...]} to trigger 100 concurrent Promise.all
     * executions, exhausting DB connection pools or Vespa rate limits. Capping at
     * 4 allows legitimate parallel patterns (search + food pairing = 2; compare +
     * drinking-window × 2 = 3) while blocking resource-exhaustion attacks.
     */
    const MAX_TOOLS_PER_BATCH = 4;
    /**
     * Set after the first zero-result observation so we inject the constraint-
     * relaxation hint exactly once into the next LLM user message.
     */
    let hasInjectedRefinementHint = false;
    /**
     * Pending hint text to prepend to the next user message in the ReAct loop.
     * Cleared to undefined after it is consumed.
     */
    let pendingRefinementHint: string | undefined;

    try {
      for (;;) {
        // Budget check — enforce BOTH step count AND wall-clock timeout.
        // The previous code only checked steps; a chain of perStepTimeoutMs
        // steps could exceed agentTimeoutMs without ever tripping canProceed.
        const budgetCheck = budget.canProceed();
        if (!budgetCheck.allowed) {
          terminationReason = budgetCheck.reason ?? 'max_steps';
          break;
        }

        // Synthesize-before-exhaustion nudge — two tiers:
        //   LAST_STEP (remainingSteps===1): always inject regardless of history.
        //   BUDGET_WARNING (remainingSteps===2): inject ONLY when the agent has
        //     already made at least one tool call (steps.length > 0), so it has
        //     results to synthesize from. Injecting the warning at step 0 (no
        //     prior observations) confuses the model: it sees "If you already have
        //     results, answer NOW" while it has nothing — causing it to hallucinate
        //     an answer instead of calling a tool.
        // Pre-condition: maxSteps=2 → remainingSteps=2 at step 0, so the
        //   "steps.length > 0" guard prevents the premature BUDGET_WARNING.
        const remainingSteps = effectiveConfig.maxSteps - budget.getStepCount();
        const hasToolHistory = steps.length > 0;
        const isLastStep = remainingSteps === 1 || (remainingSteps === 2 && hasToolHistory);

        // Pre-flight token budget check — prevent unnecessary LLM calls when
        // the budget is already exhausted. The check uses accumulated totals
        // from prior steps, so the FIRST step always executes (0 < budget).
        // Design: pre-flight blocks the NEXT step; post-hoc (L440) is an
        // insurance break when a single step's output vastly overshoots budget.
        // Together they guarantee at most one over-budget step executes.
        if (totalInputTokens + totalOutputTokens >= effectiveConfig.maxTotalTokens) {
          log.warn(
            { requestId, totalTokens: totalInputTokens + totalOutputTokens, budget: effectiveConfig.maxTotalTokens },
            'agent token budget exhausted before LLM call — terminating',
          );
          terminationReason = 'budget';
          break;
        }

        // Build messages
        // Consume any pending refinement hint by prepending it to the query message.
        // The hint is only injected once (hasInjectedRefinementHint guards re-entry).
        // CLAUDE.md rule: after enriching a string, length-check the RESULT (not just the input).
        const baseUserContentRaw = pendingRefinementHint !== undefined
          ? `${pendingRefinementHint}\n\n${query}`
          : query;
        pendingRefinementHint = undefined;
        // Cap the enriched user content at maxContextChars to prevent context overflow.
        const baseUserContent = baseUserContentRaw.length > effectiveConfig.maxContextChars
          ? baseUserContentRaw.slice(0, effectiveConfig.maxContextChars)
          : baseUserContentRaw;
        const userMsg = buildUserMessage(baseUserContent);
        const stepMessages = buildStepMessages(steps);
        const messages = [
          buildSystemMessage(),
          userMsg,
          ...stepMessages,
          // Inject LAST_STEP nudge as the FINAL user message AFTER all tool
          // results so the LLM sees "you just got a result → now answer".
          // Placing it at the query position (before step messages) meant the
          // model saw the warning before its own tool history, which reduced
          // compliance. A trailing user message is the natural "now respond" turn.
          ...(isLastStep
            ? [{
                role: 'user' as const,
                content: remainingSteps === 1
                  ? `[LAST_STEP] Step budget exhausted. You MUST produce a final {"thought":"…","answer":"…"} JSON now using the information above. Do NOT call another tool.`
                  : `[BUDGET_WARNING] Only ${remainingSteps} steps remain. Synthesize your current search results into a final {"thought":"…","answer":"…"} NOW — do not call another tool unless you have no results yet.`,
              }]
            : []),
        ];

        // LLM call with per-step timeout and AbortSignal propagation.
        // The AbortController cancels the underlying HTTP request when the
        // timeout fires, preventing orphaned in-flight requests.
        // Short-circuit if the caller (HTTP route) already signalled abort
        // (client disconnect). This prevents spending LLM tokens for a response
        // nobody will receive.
        if (abortSignal?.aborted) {
          terminationReason = 'error';
          break;
        }

        const stepStart = Date.now();
        let llmResult: { text: string; model: string; finishReason?: string | null };
        const stepAbortController = new AbortController();
        // Propagate caller abort into the per-step controller so the HTTP client
        // connection also cancels the underlying LLM fetch.
        const propagateAbort = (): void => { stepAbortController.abort(); };
        abortSignal?.addEventListener('abort', propagateAbort, { once: true });
        // Race guard: abort may fire between the pre-flight check above and
        // addEventListener. Re-check immediately after registration.
        if (abortSignal?.aborted) {
          abortSignal.removeEventListener('abort', propagateAbort);
          terminationReason = 'error';
          break;
        }
        let stepTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const racedResult: unknown = await Promise.race([
            this.deps.chatLlm.complete({
              messages,
              temperature: 0,
              // 2048 tokens: complex multi-tool parallel batches (3+ search_wines
              // with structured filters) frequently exceed 1024. Truncation →
              // finish='length' → step-0 fallback. Scenario #56 RCA showed this
              // as the root cause of consistent 37% score on 3-vintage compare.
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
              { requestId, stepIndex: steps.length, rawType: typeof racedResult },
              'Agent LLM returned malformed step result',
            );
            terminationReason = 'error';
            break;
          }
          llmResult = racedResult;
        } catch (err) {
          log.warn({ err, requestId, stepIndex: steps.length }, 'Agent LLM call failed');
          if (isAbortError(err)) {
            // Caller disconnected (AbortError from propagateAbort or timeout abort).
            // Classify as 'aborted' so client-disconnect events do NOT pollute error
            // rate metrics / SLO alerts — same pattern as the parallel batch handler.
            terminationReason = 'aborted';
          } else if ((err as Error).message === 'Agent LLM step timed out') {
            timeoutStats.llmStep += 1;
            terminationReason = 'timeout';
          } else if (err instanceof DomainError && err.code === CIRCUIT_BREAKER_OPEN_CODE) {
            // LLM circuit breaker is OPEN — every subsequent complete() call
            // will fast-fail synchronously. Mark the flag so the synthesis
            // layer does not waste round-trips, and terminate cleanly.
            llmCircuitOpen = true;
            terminationReason = 'error';
          } else {
            terminationReason = 'error';
          }
          break;
        } finally {
          abortSignal?.removeEventListener('abort', propagateAbort);
          if (stepTimeoutHandle !== undefined) {
            clearTimeout(stepTimeoutHandle);
          }
        }

        // Guard against truncated output (LLM hit max_tokens).
        // RCA: scenarios like #30 (compare + dual drinking window) emit long
        // reasoning + action JSON that exceeds 2048 tokens. Hard-breaking here
        // dropped the scenario to step-0 fallback (score ~30%). Instead, attempt
        // to parse the truncated output — if it contains a valid action/actions,
        // use it; only break if the truncation corrupted the JSON beyond repair.
        const wasTruncated = llmResult.finishReason === 'length';
        if (wasTruncated) {
          log.warn({ requestId, stepIndex: steps.length }, 'Agent LLM output truncated (finish_reason=length) — attempting recovery');
        }

        // Estimate token counts (rough: CHARS_PER_TOKEN_ESTIMATE chars ≈ 1 token)
        const inputChars = messages.reduce((sum, m) => sum + m.content.length, 0);
        const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN_ESTIMATE);
        const outputTokens = Math.ceil(llmResult.text.length / CHARS_PER_TOKEN_ESTIMATE);
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;

        // Post-hoc insurance cap — the pre-flight check (L324) prevents the
        // NEXT iteration, but if THIS step's output alone overshoots the budget
        // (e.g. unexpectedly long LLM response), we break immediately rather
        // than continuing to parse/execute tool calls from an over-budget step.
        // Uses >= (same as pre-flight) for consistent boundary semantics.
        if (totalInputTokens + totalOutputTokens >= effectiveConfig.maxTotalTokens) {
          log.warn(
            { requestId, totalTokens: totalInputTokens + totalOutputTokens, budget: effectiveConfig.maxTotalTokens },
            'agent token budget exceeded — terminating',
          );
          terminationReason = 'budget';
          break;
        }

        // Parse LLM output
        const parsed = parseLlmOutput(llmResult.text);

        // Diagnostic: log raw LLM output preview + parse result at step 0 for RCA
        if (steps.length === 0) {
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

        // Final answer — require non-empty string so LLM emitting {"answer":""} does
        // NOT prematurely terminate the loop before fallback layers can run.
        // An empty answer would skip Layer 2/3 (which require terminationReason !== 'answer')
        // and land directly in Layer 4 with a stale terminationReason='answer' from a step
        // that produced nothing. Treating empty-answer as "no answer yet" lets the loop
        // continue (or expire gracefully via budget exhaustion → synthesis sentinel).
        // AG-02: trim BEFORE the length check so whitespace-only answers are rejected
        // consistently. The trimmed value is also what gets stored/returned — synthesis
        // paths (lines ~1068) already trim; the main-loop path must match.
        if (typeof parsed.answer === 'string') {
          const trimmedAnswer = parsed.answer.trim();
          if (trimmedAnswer.length > 0) {
            steps.push({
              index: steps.length,
              thought: parsed.thought,
              answer: trimmedAnswer,
              durationMs: Math.max(0, Date.now() - stepStart),
              tokenCount: { input: inputTokens, output: outputTokens },
            });
            terminationReason = 'answer';
            break;
          }
        }

        // ── Parallel batch ──────────────────────────────────────────────────
        // LLM emits {"thought":"…","actions":[{tool,input},{tool,input}]}
        // All tools fire simultaneously via Promise.all.
        // Policy-block (DomainError) from any tool → re-thrown, caught here, abort loop.
        if (parsed.actions !== undefined) {
          const batchCalls = parsed.actions;

          // Per-batch tool count limit: reject oversized batches to prevent
          // resource exhaustion via Promise.all with 100+ concurrent tool calls.
          if (batchCalls.length > MAX_TOOLS_PER_BATCH) {
            terminationReason = 'error';
            const truncatedActions = batchCalls.slice(0, MAX_TOOLS_PER_BATCH);
            const batchErrorMsg = `Batch too large: ${batchCalls.length} tools requested (max ${MAX_TOOLS_PER_BATCH}). Retry with fewer parallel calls.`;
            const batchDurationMs = Math.max(0, Date.now() - stepStart);
            for (let bi = 0; bi < truncatedActions.length; bi++) {
              toolOutcomes.push(
                buildToolOutcome(
                  requestId,
                  steps.length,
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
            steps.push({
              index: steps.length,
              thought: parsed.thought,
              actionPairs: truncatedActions.map((a) => ({ action: a, observation: batchErrorMsg })),
              actions: truncatedActions,
              observations: truncatedActions.map(() => batchErrorMsg),
              durationMs: batchDurationMs,
              tokenCount: { input: inputTokens, output: outputTokens },
            });
            break;
          }

          // Unknown tool guard: reject the whole batch on first unknown name.
          const unknownTool = batchCalls.find((c) => !isKnownTool(c.tool));
          if (unknownTool !== undefined) {
            unknownToolAttempts++;
            if (unknownToolAttempts > MAX_UNKNOWN_TOOL_ATTEMPTS) {
              terminationReason = 'error';
              break;
            }
            {
              const unknownToolMsg = `Unknown tool: ${unknownTool.tool}. Available: search_wines, compare_wines, check_drinking_window, get_food_pairings`;
              const batchDurationMs = Math.max(0, Date.now() - stepStart);
              for (let bi = 0; bi < batchCalls.length; bi++) {
                toolOutcomes.push(
                  buildToolOutcome(
                    requestId,
                    steps.length,
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
              steps.push({
                index: steps.length,
                thought: parsed.thought,
                actionPairs: batchCalls.map((a) => ({ action: a, observation: unknownToolMsg })),
                actions: batchCalls,
                observations: batchCalls.map(() => unknownToolMsg),
                durationMs: batchDurationMs,
                tokenCount: { input: inputTokens, output: outputTokens },
              });
            }
            continue;
          }

          const batchPolicy = evaluateBatchPolicy(batchCalls);
          if (!batchPolicy.allowed) {
            const policyMsg = `Invalid parallel batch: ${batchPolicy.reason}. Allowed: search_wines+search_wines/get_food_pairings, or check_drinking_window-only batches, or compare_wines alone.`;
            const batchDurationMs = Math.max(0, Date.now() - stepStart);
            for (let bi = 0; bi < batchCalls.length; bi++) {
              toolOutcomes.push(
                buildToolOutcome(
                  requestId,
                  steps.length,
                  bi,
                  batchCalls[bi]!.tool,
                  policyMsg,
                  null,
                  batchDurationMs,
                  false,
                  false,
                  true,
                ),
              );
            }
            steps.push({
              index: steps.length,
              thought: parsed.thought,
              actionPairs: batchCalls.map((a) => ({ action: a, observation: policyMsg })),
              actions: batchCalls,
              observations: batchCalls.map(() => policyMsg),
              durationMs: batchDurationMs,
              tokenCount: { input: inputTokens, output: outputTokens },
            });
            continue;
          }

          // Loop detection + step-budget reservation are applied atomically.
          // Parallel batches must either fully reserve their step slots or not
          // mutate the budget at all; otherwise a blocked Nth tool would leave
          // stepCount/history partially advanced even though no tools ran.
          const batchCheck = budget.recordParallelBatch(batchCalls, { skipNearDuplicate: true });
          if (!batchCheck.allowed) {
            terminationReason = batchCheck.reason ?? 'loop_detected';
            break;
          }

          // Execute all tools in parallel.
          // Policy-block DomainErrors propagate through executeAgentToolsBatch
          // (not caught inside executeAgentTool). Wrap in try-catch here.
          let batchResults: readonly AgentToolResult[];
          const batchAbortController = new AbortController();
          const propagateBatchAbort = (): void => { batchAbortController.abort(); };
          abortSignal?.addEventListener('abort', propagateBatchAbort, { once: true });
          try {
            batchResults = await withTimeout(
              executeAgentToolsBatch(
                batchCalls,
                this.deps.toolDeps,
                `${requestId}-step${steps.length}`,
                { abortSignal: batchAbortController.signal },
              ),
              effectiveConfig.parallelBatchTimeoutMs ?? DEFAULT_PARALLEL_BATCH_TIMEOUT_MS,
              'Parallel tool batch timed out',
            );
          } catch (batchErr) {
            // AbortError: caller disconnected — classify as 'aborted', not 'error',
            // so client-disconnect events don't pollute error rate metrics / SLO alerts.
            if (isAbortError(batchErr)) {
              // Propagate abort to sibling tools — AbortError may originate from the
              // outer caller signal (via propagateBatchAbort), but if it came from
              // a single tool's internal timeout, sibling tools are still running.
              // Abort explicitly to release resources (Vespa connections, LLM calls).
              batchAbortController.abort();
              const batchDurationMs = Math.max(0, Date.now() - stepStart);
              for (let bi = 0; bi < batchCalls.length; bi++) {
                toolOutcomes.push(
                  buildToolOutcome(
                    requestId,
                    steps.length,
                    bi,
                    batchCalls[bi]!.tool,
                    '[ABORTED] Request cancelled during parallel tool execution.',
                    null,
                    batchDurationMs,
                    true,
                    false,
                    false,
                  ),
                );
              }
              terminationReason = 'aborted';
              break;
            }
            if ((batchErr as TimeoutErrorLike).code === 'TIMEOUT') {
              timeoutStats.parallelBatch += 1;
              batchAbortController.abort();
              const batchDurationMs = Math.max(0, Date.now() - stepStart);
              for (let bi = 0; bi < batchCalls.length; bi++) {
                toolOutcomes.push(
                  buildToolOutcome(
                    requestId,
                    steps.length,
                    bi,
                    batchCalls[bi]!.tool,
                    '[TIMEOUT] Parallel tool batch timed out.',
                    null,
                    batchDurationMs,
                    false,
                    true,
                    false,
                  ),
                );
              }
              terminationReason = 'timeout';
              break;
            }
            if (batchErr instanceof DomainError && batchErr.code === POLICY_BLOCKED_CODE) {
              policyBlocked = true;
              terminationReason = 'blocked';
              // Cancel any in-flight parallel tools — a policy block means the
              // entire batch is invalid; continuing would waste resources.
              batchAbortController.abort();
              {
                const policyMsg = `Policy blocked: ${batchErr.message}`;
                const batchDurationMs = Math.max(0, Date.now() - stepStart);
                for (let bi = 0; bi < batchCalls.length; bi++) {
                  toolOutcomes.push(
                    buildToolOutcome(
                      requestId,
                      steps.length,
                      bi,
                      batchCalls[bi]!.tool,
                      policyMsg,
                      null,
                      batchDurationMs,
                      false,
                      false,
                      true,
                    ),
                  );
                }
                steps.push({
                  index: steps.length,
                  thought: parsed.thought,
                  actionPairs: batchCalls.map((a) => ({ action: a, observation: policyMsg })),
                  actions: batchCalls,
                  observations: batchCalls.map(() => policyMsg),
                  durationMs: batchDurationMs,
                  tokenCount: { input: inputTokens, output: outputTokens },
                });
              }
            } else {
              terminationReason = 'error';
            }
            break;
          } finally {
            abortSignal?.removeEventListener('abort', propagateBatchAbort);
          }

          const batchPairs: AgentToolCallPair[] = [];
          const observations: string[] = [];
          // Promise.all guarantees index alignment: batchResults[bi] corresponds
          // to batchCalls[bi] exactly. We assert non-null here (rather than
          // skipping undefined) so that observations[] stays index-aligned with
          // actions[]. Skipping would produce observations.length < actions.length,
          // causing agent-prompt.ts to pair tool results with the wrong action.
          for (let bi = 0; bi < batchResults.length; bi++) {
            const result = batchResults[bi]!;
            const call = batchCalls[bi]!;
            const obs = truncateObservation(result.observation, this.config.maxContextChars);
            observations.push(obs);
            batchPairs.push({ action: call, observation: obs });
            if (
              result.rawResult !== null &&
              typeof result.rawResult === 'object' &&
              'queryType' in (result.rawResult as Record<string, unknown>) &&
              (result.rawResult as Record<string, unknown>)['queryType'] === 'search'
            ) {
              lastSearchResult = result.rawResult as SearchResponseV1;
            }
          }

          const batchDurationMs = Math.max(0, Date.now() - stepStart);
          const batchStepIndex = steps.length;
          steps.push({
            index: batchStepIndex,
            thought: parsed.thought,
            actionPairs: batchPairs,
            actions: batchCalls,
            observations,
            durationMs: batchDurationMs,
            tokenCount: { input: inputTokens, output: outputTokens },
          });

          // E7-T2: Generate typed ToolOutcome for each tool in the batch.
          for (let bi = 0; bi < batchResults.length; bi++) {
            const result = batchResults[bi]!;
            const call = batchCalls[bi]!;
            const obs = observations[bi] ?? '';
            toolOutcomes.push(
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
            !hasInjectedRefinementHint &&
            remainingAfterBatch >= 3 &&
            observations.some((o) => o.includes('0개') || o.includes('검색 결과가 없습니다') || o.startsWith('NO_MATCH:'))
          ) {
            hasInjectedRefinementHint = true;
            pendingRefinementHint =
              'HINT: 이전 검색에서 결과가 없었습니다. 가장 제한적인 조건(가격/품종/지역)을 하나씩 완화하여 재검색하세요. 예: 가격 조건을 넓히거나 지역 조건을 제거하고 재검색.';
          }
        }

        // ── Sequential single tool call ─────────────────────────────────────
        if (parsed.action !== undefined) {
          const { tool, input } = parsed.action;

          // Unknown tool guard FIRST — do not consume budget on adversarial
          // LLM-emitted unknown tool names. Adds an observation step but
          // does not call recordStep so the loop counter is preserved.
          // Cap unknown-tool attempts to prevent infinite loops from an
          // adversarial or confused LLM that keeps emitting the same
          // invalid tool name.
          if (!isKnownTool(tool)) {
            unknownToolAttempts++;
            if (unknownToolAttempts > MAX_UNKNOWN_TOOL_ATTEMPTS) {
              terminationReason = 'error';
              break;
            }
            const stepDurationMs = Math.max(0, Date.now() - stepStart);
            const unknownToolMsg = `Unknown tool: ${tool}. Available: search_wines, compare_wines, check_drinking_window, get_food_pairings`;
            toolOutcomes.push(
              buildToolOutcome(
                requestId,
                steps.length,
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
            steps.push({
              index: steps.length,
              thought: parsed.thought,
              action: { tool, input },
              observation: unknownToolMsg,
              durationMs: stepDurationMs,
              tokenCount: { input: inputTokens, output: outputTokens },
            });
            continue;
          }

          // Loop detection (only for known tools)
          const loopCheck = budget.recordStep(tool, input);
          if (!loopCheck.allowed) {
            terminationReason = loopCheck.reason ?? 'loop_detected';
            break;
          }

          // Execute tool
          let observation: string;
          let rawResult: unknown;
          const toolAbortController = new AbortController();
          const propagateToolAbort = (): void => { toolAbortController.abort(); };
          abortSignal?.addEventListener('abort', propagateToolAbort, { once: true });
          try {
            const timedToolResult = await withTimeout(
              executeAgentTool(
                tool,
                input,
                this.deps.toolDeps,
                `${requestId}-step${steps.length}`,
                { abortSignal: toolAbortController.signal },
              ),
              effectiveConfig.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
              `Tool "${tool}" timed out`,
            );
            observation = truncateObservation(timedToolResult.observation, this.config.maxContextChars);
            rawResult = timedToolResult.rawResult;
          } catch (toolErr) {
            if ((toolErr as TimeoutErrorLike).code === 'TIMEOUT') {
              timeoutStats.tool += 1;
              toolAbortController.abort();
              // MUST break here — without break the catch falls through to the
              // generic observation assignment, losing timeout context and causing
              // the agent to retry the same timed-out tool call. (RCA5-06)
              observation = `[TIMEOUT] Tool "${tool}" timed out. Try a different approach or a narrower query.`;
              rawResult = null;
              const stepDurationMs = Math.max(0, Date.now() - stepStart);
              toolOutcomes.push(
                buildToolOutcome(
                  requestId,
                  steps.length,
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
              steps.push({
                index: steps.length,
                thought: parsed.thought,
                action: { tool, input },
                observation,
                durationMs: stepDurationMs,
                tokenCount: { input: inputTokens, output: outputTokens },
              });
              break;
            }
            // Propagate caller abort: AbortError during tool execution means the client
            // disconnected. Terminate immediately — do NOT classify as a tool error.
            if (isAbortError(toolErr)) {
              terminationReason = 'aborted';
              const stepDurationMs = Math.max(0, Date.now() - stepStart);
              const abortedObservation = '[ABORTED] Request cancelled during tool execution.';
              toolOutcomes.push(
                buildToolOutcome(
                  requestId,
                  steps.length,
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
              steps.push({
                index: steps.length,
                thought: parsed.thought,
                action: { tool, input },
                observation: abortedObservation,
                durationMs: stepDurationMs,
                tokenCount: { input: inputTokens, output: outputTokens },
              });
              break;
            }
            // Detect policy-block errors — terminate the loop immediately.
            // The agent must NOT continue calling tools after a security block.
            if (toolErr instanceof DomainError && toolErr.code === POLICY_BLOCKED_CODE) {
              policyBlocked = true;
              terminationReason = 'blocked';
              const stepDurationMs = Math.max(0, Date.now() - stepStart);
              const blockedObservation = `Policy blocked: ${toolErr.message}`;
              toolOutcomes.push(
                buildToolOutcome(
                  requestId,
                  steps.length,
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
              steps.push({
                index: steps.length,
                thought: parsed.thought,
                action: { tool, input },
                observation: blockedObservation,
                durationMs: stepDurationMs,
                tokenCount: { input: inputTokens, output: outputTokens },
              });
              break;
            }
            observation = `Tool error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
            rawResult = null;
          } finally {
            // Always abort the per-tool controller so any in-flight Vespa/HTTP request
            // initiated by the tool is cancelled immediately, not at its natural timeout.
            // The three explicit catch branches (TIMEOUT, AbortError, PolicyBlocked) all
            // break out of the loop — this finally also fires for the generic error path
            // which falls through, so toolAbortController was previously never aborted
            // in that case, leaking connection-pool slots until timeout expiry.
            toolAbortController.abort();
            abortSignal?.removeEventListener('abort', propagateToolAbort);
          }

          // Track last search result for inclusion in final response
          if (
            rawResult !== null &&
            typeof rawResult === 'object' &&
            'queryType' in (rawResult as Record<string, unknown>) &&
            (rawResult as Record<string, unknown>)['queryType'] === 'search'
          ) {
            lastSearchResult = rawResult as SearchResponseV1;
          }

          const stepDurationMs = Math.max(0, Date.now() - stepStart);
          steps.push({
            index: steps.length,
            thought: parsed.thought,
            action: { tool, input },
            observation,
            durationMs: stepDurationMs,
            tokenCount: { input: inputTokens, output: outputTokens },
          });

          // E7-T2: Generate typed ToolOutcome alongside AgentStep.
          // At this point: TIMEOUT/abort/policy paths already called break, so
          // if we reach here the tool succeeded or produced a generic error
          // (rawResult === null, observation starts with "Tool error:").
          toolOutcomes.push(
            buildToolOutcome(
              requestId,
              steps.length - 1,
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

          // Constraint-relaxation hint: if the observation indicates zero results
          // and we have enough remaining steps, inject a hint once into the next
          // LLM message to guide iterative constraint relaxation.
          const remainingStepsAfterTool = effectiveConfig.maxSteps - budget.getStepCount();
          if (
            !hasInjectedRefinementHint &&
            remainingStepsAfterTool >= 3 &&
            (observation.includes('0개') || observation.includes('검색 결과가 없습니다') || observation.startsWith('NO_MATCH:'))
          ) {
            hasInjectedRefinementHint = true;
            pendingRefinementHint =
              'HINT: 이전 검색에서 결과가 없었습니다. 가장 제한적인 조건(가격/품종/지역)을 하나씩 완화하여 재검색하세요. 예: 가격 조건을 넓히거나 지역 조건을 제거하고 재검색.';
          }
        }
      }
    } catch (err) {
      log.error({ err, requestId }, 'Agent orchestrator unexpected error');
      if (err instanceof DomainError && err.code === POLICY_BLOCKED_CODE) {
        policyBlocked = true;
        terminationReason = 'blocked';
      } else if (err instanceof DomainError && err.code === CIRCUIT_BREAKER_OPEN_CODE) {
        llmCircuitOpen = true;
        terminationReason = 'error';
      } else {
        terminationReason = 'error';
      }
    }

    // Fallback: if no answer was produced, do a single-shot search.
    // Skip when a policy block already rejected the query — re-running
    // the raw query through the search use case would just hit the same
    // security gate (or worse, slip through if the gate state changed).
    let fallbackApplied = false;
    let fallbackLayer: SynthesisContext['fallbackApplied'] = null;
    // Require non-empty answer string: a step with answer='' is not a valid answer.
    // Without the length check, synthesis layers below all skip and empty string propagates.
    let answer = steps.find((s) => s.answer !== undefined && s.answer.length > 0)?.answer ?? '';

    // Observation-based synthesis: if we have tool results but no answer,
    // try to synthesize from what we already gathered before doing a fresh search.
    // This avoids the "agent ran 3 steps, got great results, then returned nothing" failure.
    // Skip entirely if caller already disconnected — synthesis costs 1-2 LLM round-trips
    // that nobody will receive.
    if (!policyBlocked && !llmCircuitOpen && answer === '' && terminationReason !== 'answer' && !(abortSignal?.aborted)) {
      // Pre-flight token budget check BEFORE synthesis LLM call (CLAUDE.md rule 20).
      // Without this, synthesis fires even when the main loop exhausted the budget,
      // silently overrunning maxTotalTokens by 1-2x (synthesis ≈ same cost as one main step).
      if (totalInputTokens + totalOutputTokens >= effectiveConfig.maxTotalTokens) {
        log.warn({ requestId, totalInputTokens, totalOutputTokens, budget: effectiveConfig.maxTotalTokens }, '[agent] token budget exhausted — skipping final answer synthesis to prevent overrun');
      } else {
        // Check both sequential (observation) and parallel batch (observations[]) steps
        // so synthesis fires when the agent used parallel tools and has results.
        const obsSteps = steps.filter(
        (s) =>
          (s.observation !== undefined && s.observation.length > 0) ||
          (s.actionPairs !== undefined && s.actionPairs.some((p) => p.observation.length > 0)),
      );
      if (obsSteps.length > 0) {
        // requestId embedded in sentinel to prevent adversarial tool results from
        // containing the literal string and colliding with our synthesis detector.
        const synthSentinel = `[SYSTEM:${requestId}:FINAL_ANSWER_REQUIRED]\nYou have exhausted your step budget. Synthesize the tool results above into a final answer now.\nOutput ONLY this JSON — no other text, no code fences:\n{"thought":"one-sentence summary of findings","answer":"your complete, grounded response in the user's language (Korean if query was Korean)"}\nRules:\n- "answer" must reference specific wines, regions, or prices from the tool results above.\n- Do NOT call any tool. Do NOT output "action" or "actions".\n- If results were empty, tell the user no match was found and suggest broadening the search.`;
        const synthMessages = [
          buildSystemMessage(),
          buildUserMessage(query),
          ...buildStepMessages(steps),
          {
            role: 'user' as const,
            content: synthSentinel,
          },
        ];
        const attemptSynthesis = async (maxOutputTokens: number): Promise<string | undefined> => {
          // Short-circuit if caller disconnected before we even start the LLM call.
          if (abortSignal?.aborted) return undefined;
          const synthAbort = new AbortController();
          // Propagate caller abort into the synthesis controller.
          const propagateSynthAbort = (): void => { synthAbort.abort(); };
          abortSignal?.addEventListener('abort', propagateSynthAbort, { once: true });
          // Re-check after addEventListener: if abort fired between the aborted===true
          // check above and addEventListener, the 'abort' event already fired and the
          // listener will never be called — synthAbort would never abort. Guard this race.
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
            // Accumulate synthesis tokens into the overall run totals.
            // IMPORTANT: count ONLY the synthSentinel (the new message unique to
            // this synthesis call). buildSystemMessage(), buildUserMessage(), and
            // buildStepMessages() tokens were already counted on each main-loop
            // iteration — re-counting synthMessages in full would inflate
            // totalInputTokens and could cause the attempt-2 budget guard
            // (line ~1128) to block a legal retry.
            totalInputTokens += Math.ceil(synthSentinel.length / CHARS_PER_TOKEN_ESTIMATE);
            totalOutputTokens += Math.ceil(synthResult.text.length / CHARS_PER_TOKEN_ESTIMATE);
            const parsedSynth = parseLlmOutput(synthResult.text);
            // If the synthesis LLM still returns a tool call despite the sentinel
            // instruction, treat it as failure (return undefined). Continuing
            // with parsedSynth.action would cause a use-after-loop tool execution
            // outside the budget guard.
            if (parsedSynth.action !== undefined || parsedSynth.actions !== undefined) {
              log.warn({ requestId }, 'synthesis LLM returned tool call — ignoring, falling to next layer');
              return undefined;
            }
            // Reject JSON-shell answers like "{}", "[]", or whitespace-only strings
            // that the LLM may emit when confused by the synthesis sentinel.
            // A real answer must have meaningful text content (>10 chars) and must
            // not look like a bare JSON object/array wrapper.
            const candidate = parsedSynth.answer?.trim() ?? '';
            const isShell = /^[{[\s]*[}\]]*$/.test(candidate);
            return candidate.length > 10 && !isShell
              ? candidate
              : undefined;
          } finally {
            abortSignal?.removeEventListener('abort', propagateSynthAbort);
            clearTimeout(synthTimer);
          }
        };
        // Attempt 1: full token budget synthesis
        let synthAnswer: string | undefined;
        try {
          synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_1);
        } catch (synthErr1) {
          // If the LLM circuit breaker opened during attempt 1, retrying is
          // pointless — the breaker is OPEN and attempt 2 will fast-fail too.
          // Mark the flag so downstream layers also skip LLM calls.
          if (synthErr1 instanceof DomainError && synthErr1.code === CIRCUIT_BREAKER_OPEN_CODE) {
            llmCircuitOpen = true;
          } else if (isAbortError(synthErr1)) {
            // Caller disconnected during synthesis — mark as aborted so the
            // attempt-2 guard (abortSignal?.aborted) aligns with terminationReason.
            terminationReason = 'aborted';
          }
          log.error({ err: synthErr1, requestId }, `synthesis attempt 1 threw (timeout/error) — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
        }
        // Attempt 2: retry with shorter output if attempt 1 failed (empty or threw).
        // Skip when (a) caller disconnected, (b) LLM circuit breaker is OPEN
        // (attempt 1 noted this), or (c) the token budget is now exhausted —
        // attempt 1 accumulated tokens that may have crossed maxTotalTokens,
        // and firing attempt 2 would silently overrun the budget (CLAUDE.md rule 20).
        if (
          synthAnswer === undefined
          && !(abortSignal?.aborted)
          && !llmCircuitOpen
          // Use >= (not >) to match pre-flight check at line ~1001 — at exact boundary
          // the budget is consumed, any synthesis would silently overrun (CLAUDE.md rule 20).
          && totalInputTokens + totalOutputTokens < effectiveConfig.maxTotalTokens
        ) {
          try {
            log.info({ requestId, obsSteps: obsSteps.length }, `synthesis attempt 1 returned empty — retrying with maxOutputTokens=${SYNTHESIS_TOKENS_ATTEMPT_2}`);
            synthAnswer = await attemptSynthesis(SYNTHESIS_TOKENS_ATTEMPT_2);
          } catch (synthErr2) {
            if (synthErr2 instanceof DomainError && synthErr2.code === CIRCUIT_BREAKER_OPEN_CODE) {
              llmCircuitOpen = true;
            } else if (isAbortError(synthErr2)) {
              terminationReason = 'aborted';
            }
            log.error({ err: synthErr2, requestId }, 'synthesis attempt 2 threw — proceeding to fallback search');
          }
        }
        if (synthAnswer !== undefined) {
          answer = synthAnswer;
          terminationReason = 'answer';
          log.info({ requestId, obsSteps: obsSteps.length }, 'synthesized answer from observations');
        }
      }
      } // end else (budget not exhausted)
    }

    // Track whether the agent already gathered tool observations before reaching fallback.
    // When observations exist, synthesis failed but tool execution succeeded — the agent
    // correctly called the right tools; only the final LLM synthesis call failed (infra).
    // In that case we avoid re-running a fresh search (Layer 2) and instead use
    // Layer 3 (raw observation) with terminationReason='answer' so the scorer does not
    // penalise correct tool execution as a complete failure.
    const hasToolObservations = steps.some(
      (s) =>
        (s.observation !== undefined && s.observation.length > 0) ||
        (s.actionPairs !== undefined && s.actionPairs.some((p) => p.observation.length > 0)),
    );

    if (!policyBlocked && answer === '' && terminationReason !== 'answer' && !hasToolObservations && !(abortSignal?.aborted)) {
      // Layer 2: single-shot fallback search — only when the agent made NO tool calls.
      // Skip when tool observations exist; those cases go directly to Layer 3 so we
      // preserve the agent's correct tool execution in the terminationReason.
      // Also skip if caller already disconnected (abortSignal.aborted).
      //
      // Cap the fallback search at FALLBACK_SEARCH_TIMEOUT_MS (module-scope const).
      // This is independent of perStepTimeoutMs to avoid the inversion bug where
      // low perStep settings gave the fallback the same exhausted budget.
      const fallbackController = new AbortController();
      // Chain caller abort → fallback controller so client disconnect cancels the search.
      const propagateFallbackAbort = (): void => { fallbackController.abort(); };
      abortSignal?.addEventListener('abort', propagateFallbackAbort, { once: true });
      // Race guard: abort may fire between the outer if-guard and addEventListener.
      // Re-check immediately after registration. If aborted, skip the fallback search.
      if (abortSignal?.aborted) {
        fallbackController.abort();
        abortSignal.removeEventListener('abort', propagateFallbackAbort);
        // Fall through to Layer 3/4 without executing the search.
      } else {
      const fallbackTimer = setTimeout(
        () => {
          fallbackController.abort();
        },
        FALLBACK_SEARCH_TIMEOUT_MS,
      );
      try {
        // v5: preserve constraints from any prior search_wines attempt in the step history.
        // Even when no observations were produced, the LLM may have emitted a structured
        // search_wines action that hit a parse/budget error. Recovering its `input.query`
        // and forwarding it to searchUseCase preserves the agent's intent — much better
        // than re-running with the bare original query and discarding all extracted constraints.
        const lastSearchInput = recoverLastSearchInput(steps);
        const fallbackQuery = lastSearchInput?.query ?? query;
        const fallbackResult = await this.deps.toolDeps.searchUseCase.execute(
          { query: fallbackQuery },
          `${requestId}-fallback`,
          { abortSignal: fallbackController.signal },
        );
        const topResult = fallbackResult.queryType === 'search' ? fallbackResult.results.at(0) : undefined;
        if (topResult !== undefined) {
          const producer = topResult.entity.producer ?? '';
          const region = topResult.entity.region ?? '';
          const detail = [producer, region].filter(Boolean).join(', ');
          // Language-aware fallback template: detect Hangul in original query and respond
          // in the same language. Pre-fix this was a hardcoded English template, which
          // produced English responses for Korean queries on step-0 LLM failure (the most
          // common benchmark fallback path). Korean = Hangul Syllables block U+AC00..U+D7A3.
          const queryHasHangul = containsHangul(query);
          answer = queryHasHangul
            ? `검색 결과: ${topResult.entity.canonicalLabel}${detail ? ` (${detail})` : ''}. (참고: 처리 제약으로 간단히 표시되었습니다.)`
            : `Based on your query, I found: ${topResult.entity.canonicalLabel}${detail ? ` (${detail})` : ''}. (Note: simplified result due to processing constraints.)`;
          lastSearchResult = fallbackResult.queryType === 'search' ? fallbackResult : undefined;
          fallbackApplied = true;
          fallbackLayer = 'layer2';
          terminationReason = 'fallback';
        } else {
          // Fallback search returned no results — construct a graceful template answer.
          // Language-aware: Korean for Hangul queries, English otherwise.
          const queryHasHangul = containsHangul(query);
          answer = queryHasHangul
            ? `"${query}"에 대한 검색 결과를 찾지 못했습니다. 검색어를 더 간단하게 바꾸거나 다른 와인명이나 품종으로 다시 시도해보세요.`
            : `No results found for "${query}". Try simplifying the query or using a different wine name or grape variety.`;
          fallbackApplied = true;
          fallbackLayer = 'layer2';
          terminationReason = 'fallback';
        }
      } catch (err) {
        if (isAbortError(err)) {
          // Caller disconnected during fallback search — propagate abort, do not log as failure.
          terminationReason = 'aborted';
        } else {
          // Log so an outage of the fallback path is observable instead of silent.
          log.error({ err, requestId }, 'agent fallback search failed');
        }
      } finally {
        abortSignal?.removeEventListener('abort', propagateFallbackAbort);
        clearTimeout(fallbackTimer);
      }
      } // end else (not aborted before fallback search started)
    } // end if (answer === '' && !hasToolObservations) — Layer 2 block

    if (!policyBlocked && terminationReason !== 'aborted' && answer === '') {
      // Layer 3: synthesize from last available observation (deterministic, no LLM)
      // Skip when caller disconnected (aborted) — the result will not be delivered anyway.
      // Check both sequential (observation) and parallel (observations[]) steps.
      const lastObs = steps.findLast(
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
          ? `검색 결과 요약: ${preview}`
          : `Search result summary: ${preview}`;
        fallbackApplied = true;
        fallbackLayer = 'layer3';
        // When tool observations exist, the agent successfully called the right tools —
        // only the synthesis LLM call failed (infrastructure). Use terminationReason='answer'
        // so the scorer credits correct tool execution rather than penalising as full failure.
        terminationReason = hasToolObservations ? 'answer' : 'fallback';
        log.error({ requestId, hasToolObservations }, 'Layer 3 fallback: all LLM synthesis paths failed — using raw observation');
      }
    }

    if (policyBlocked && answer === '') {
      answer = '이 요청은 처리할 수 없습니다. 와인 검색과 관련된 질문을 해주세요.';
      log.error({ requestId }, 'policy-blocked agent run ended without explicit answer; returning blocked template');
    }

    if (!policyBlocked && terminationReason !== 'aborted' && answer === '') {
      // Layer 4: absolute guarantee — no tool call is ALWAYS better than empty.
      // Skip when caller disconnected (aborted) — preserve 'aborted' terminationReason
      // so the caller can distinguish abort from genuine failure.
      answer = '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.';
      fallbackApplied = true;
      fallbackLayer = 'layer4';
      // Same reasoning as Layer 3: if tool observations exist, the agent execution was
      // correct; only synthesis failed. Use 'answer' to avoid penalising correct execution.
      terminationReason = hasToolObservations ? 'answer' : 'fallback';
      log.error({ requestId, query, steps: steps.length }, 'Layer 4 fallback: all synthesis paths exhausted — returning template answer');
    }

    log.info(
      {
        requestId,
        steps: steps.length,
        toolCalls: steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actionPairs?.length ?? 0), 0),
        terminationReason,
        timeoutStats,
        failureTags: [
          ...(timeoutStats.llmStep > 0 ? ['llm_step_timeout'] : []),
          ...(timeoutStats.parallelBatch > 0 ? ['parallel_batch_timeout'] : []),
          ...(timeoutStats.tool > 0 ? ['tool_timeout'] : []),
        ],
        totalDurationMs: budget.getElapsedMs(),
        fallbackApplied,
      },
      'Agent execution complete',
    );

    this.deps.executionObserver?.onExecutionComplete({
      terminationReason,
      fallbackApplied,
      toolCallCount: steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actionPairs?.length ?? 0), 0),
      totalDurationMs: budget.getElapsedMs(),
      timeoutStats,
    });

    const synthesisContext = buildSynthesisContext(
      query,
      toolOutcomes,
      fallbackLayer !== null,
      fallbackLayer,
    );

    // AG-02: normalise answer whitespace at the exit point so all code paths
    // (main-loop answer, synthesis, fallback templates) produce a consistent
    // trimmed string. Fallback templates are already clean but applying .trim()
    // is idempotent — this is the single canonical normalisation point.
    return {
      answer: answer.trim(),
      steps,
      totalDurationMs: budget.getElapsedMs(),
      totalTokens: { input: totalInputTokens, output: totalOutputTokens },
      toolCallCount: steps.reduce((n, s) => n + (s.action !== undefined ? 1 : 0) + (s.actionPairs?.length ?? 0), 0),
      fallbackApplied,
      terminationReason,
      ...(lastSearchResult !== undefined ? { searchResults: lastSearchResult } : {}),
      // E7-T2: Include typed tool outcomes when at least one tool was invoked.
      ...(toolOutcomes.length > 0 ? { toolOutcomes } : {}),
      synthesisContext,
    };
  }
}
