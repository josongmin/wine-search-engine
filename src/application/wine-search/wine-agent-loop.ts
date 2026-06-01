/**
 * WineAgentLoopRunner — the lean ReAct loop for genuinely multi-hop queries.
 *
 * Sits between `DeterministicRouter` (which decides multi-step is needed)
 * and `SynthesisRunner` (which composes the final answer). The runner
 * drives `StructuredLlmPort.execute` with native `tool_use` blocks and
 * recomputes the next directive FUNCTIONALLY on every iteration from the
 * current observations + analysis contract. There is NO sticky state on
 * the runner — that is the architectural fix for the zombie-loop bug.
 *
 * Invariants:
 *  1. Pre-flight budget check (CLAUDE.md rule 20) — `budget.canProceed()`
 *     is consulted BEFORE the LLM call. Same for the token budget and the
 *     abort signal.
 *  2. Every terminationReason write flows through
 *     `transitionTerminationReason` (SSoT — `termination-state-machine.ts`).
 *     Hard failures dominate.
 *  3. `StepBudget` is the single source of truth for loop detection
 *     (CLAUDE.md rule 30). The runner records every dispatched call via
 *     `recordParallelBatch` (atomic across a batch) and reacts to
 *     `loop_detected` by surfacing an explicit observation back to the
 *     model. After
 *     `WINE_AGENT_LOOP_LOOP_DETECTED_TERMINATE_COUNT` rejections the loop
 *     terminates.
 *  4. Per-step timeout is enforced via `withTimeout`
 *     (SSoT — `agent-tool-execution-support.ts`). Abort listeners are
 *     cleaned up in `finally`.
 *  5. `enablePromptCache: true` is passed on every `execute` request so the
 *     static system prompt + tool defs are cached after the first turn.
 *  6. Tool dispatch uses `buildToolOutcome`
 *     (SSoT — `agent-tool-execution-support.ts`). No fabricated outcomes.
 *  7. Directive copy is Korean when `analysis.hangulDominant`, English
 *     otherwise (CLAUDE.md i18n discipline — see `wine-agent-loop-schemas.ts`).
 */

import { createHash } from 'node:crypto';
import type { ChatMessage } from '@domain/ai/port/chat-llm.port.js';
import type {
  ExecuteRequest,
  ExecuteResult,
  StructuredLlmPort,
  TokenUsage,
  ToolUseCall,
} from '@domain/ai/port/structured-llm.port.js';
import type { AgentConfig } from '@domain/agent/model/agent-config.js';
import type { AgentTerminationReason } from '@domain/agent/model/agent-step.js';
import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';
import { StepBudget } from '@domain/agent/service/step-budget.js';
import { transitionTerminationReason } from '@domain/agent/service/termination-state-machine.js';
import { bootstrapLogger } from '@domain/shared/bootstrap-logger.js';
import { abortError, isAbortError, throwIfAborted } from '@domain/shared/cooperative-abort.js';
import {
  buildToolOutcome,
  withTimeout,
} from '../agent/agent-tool-execution-support.js';
import { normalizeLookupWineInput } from '../search/lookup-wine-execution.js';
import { normalizeSimilarToEntityInput } from '../search/reference-similarity-execution.js';
import {
  sanitizeOptionalToolNulls,
} from '../search/search-tool-contract.js';
import {
  buildSearchWinesToolUseCaseInput,
} from '../search/agent-tool-request-adapter.js';
import {
  KNOWN_AGENT_TOOL_NAMES_DISPLAY,
  SEARCH_PRIMITIVE_TOOL_LANES,
  isSearchPrimitiveToolName,
} from '@domain/agent/model/agent-tool-attempt-schema.js';
import { toolResultCacheTtlSeconds } from '@domain/shared/constants/tool-cache-ttl.js';
import type { ToolResultCachePort } from './port/tool-result-cache.port.js';
import {
  addTokenUsage,
  makeZeroTokenUsage,
} from './synthesis-schemas.js';
import {
  WINE_AGENT_LOOP_DEFAULT_MODEL,
  WINE_AGENT_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT,
  WINE_AGENT_LOOP_LOOP_DETECTED_TERMINATE_COUNT,
  WINE_AGENT_LOOP_MAX_DRINKABILITY_ENTITY_IDS,
  selectDirectiveCopy,
  type WineAgentLoopDirective,
  type WineAgentLoopDirectiveCopy,
  type WineAgentLoopInput,
  type WineAgentLoopOutcome,
  type WineAgentLoopStep,
  type WineAgentLoopToolCall,
  type WineAgentLoopToolPorts,
} from './wine-agent-loop-schemas.js';
import { getCanonicalNormalizedConstraints } from './wine-search-schemas.js';
import { stableStringify } from '@shared/utils/stable-stringify.js';
import {
  SEARCH_PRIMITIVE_INPUT_SCHEMA,
} from './wine-agent-loop-tool-bundle.js';
import type {
  SearchUseCaseInput,
} from './execution-plan-schemas.js';

const defaultLog = bootstrapLogger.child({ component: 'WineAgentLoopRunner' });

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Maximum size of the rolling chat history sent to the LLM, in characters.
 *  Keeps the per-step token cost predictable when the model emits chatty
 *  observations. */
const WINE_AGENT_LOOP_MAX_HISTORY_CHARS = 12_000;

/** Truncation tail appended when the rolling history is clipped. */
const WINE_AGENT_LOOP_HISTORY_TRUNCATION_TAIL = '\n…[wine-agent-loop history truncated]';

/** Empty-result string used by `buildToolOutcome` to classify
 *  `empty_result`. Mirrors the format produced by agent tools (search
 *  returning zero results). */
const WINE_AGENT_LOOP_NO_MATCH_PREFIX = 'NO_MATCH: ';

/** Maximum number of result items we serialize back to the LLM per tool
 *  outcome. Search responses can be long; we only need the top few to
 *  drive the next reasoning step. */
const WINE_AGENT_LOOP_RESULT_PREVIEW_LIMIT = 5;

/** Magnitude that triggers the "result preview truncated" suffix in the
 *  observation. */
const WINE_AGENT_LOOP_RESULT_PREVIEW_CHARS = 1_500;

/** Truncated SHA-256 hex chars for cache-key input hash. 16 hex = 64 bits;
 *  collision probability ≈ 10⁻¹⁰ at 100K cached entries. Matches the
 *  truncation used in `redis-tool-result-cache.ts`. */
const TOOL_CACHE_INPUT_HASH_HEX_CHARS = 16;

// ---------------------------------------------------------------------------
// System prompt — static so it benefits from prompt caching.
// ---------------------------------------------------------------------------

const WINE_AGENT_LOOP_SYSTEM_PROMPT = [
  'You are a wine search agent driving a small, focused ReAct loop.',
  '',
  'Available tools:',
  '  - search_hybrid: discovery search using BOTH lexical (BM25) and semantic (embedding) retrieval fused with RRF. The DEFAULT for finding wines by constraints, region, style, price, or description.',
  '  - search_semantic: discovery search using ONLY semantic similarity (no lexical leg). Use for vibe/profile/preference queries ("light summer red").',
  '  - search_lexical: discovery search using ONLY lexical/BM25 token matching (no embedding leg). Use when exact words/names/codes matter and semantic drift is undesirable.',
  '  - lookup_wine: resolve ONE specific wine by name/identity (1-3 exact matches); use when the user names a particular wine.',
  '  - similar_to_entity: find wines SIMILAR to an ALREADY-resolved wine. Input is entity_id (copy it from a prior lookup_wine result), NOT a name. The anchor wine is excluded from results. Optional structured filters refine the set.',
  '',
  'Composition note: there are no dedicated pairing / drinkability / comparison / "similar wine" name-based tools. Compose them from primitives:',
  '  - "X 비슷한 와인" / "wines like X": lookup_wine(X) FIRST to get the entity_id, THEN similar_to_entity(entity_id). Never pass a name straight into similar_to_entity.',
  '  - comparison ("A vs B"): lookup_wine(A) then lookup_wine(B), then synthesize the comparison from the two results.',
  '  - pairing / drinkability: run one or more search_* / lookup_wine calls and synthesize from the results.',
  '',
  'Hard rules:',
  '  - Call AT MOST ONE tool per turn. If the user clearly asked for parallel work, prefer a single search with combined constraints.',
  '  - Ground every factual claim in a tool result. NEVER fabricate.',
  '  - When you emit a final answer, do NOT make additional tool calls.',
  '  - Honor any "directive" message the controller injects between turns. Directives are authoritative — they reflect contract requirements derived from the user query.',
  '  - If the controller injects a "Loop detected" notice, switch to a different tool or substantially different input on the next turn.',
].join('\n');

// ---------------------------------------------------------------------------
// Internal mutable state — closed over by `run()`, never exposed.
// ---------------------------------------------------------------------------

interface RunnerState {
  readonly steps: WineAgentLoopStep[];
  readonly toolOutcomes: ToolOutcome[];
  tokenUsage: TokenUsage;
  terminationReason: AgentTerminationReason;
  loopDetectedCount: number;
  /** Consecutive turns where the model emitted an answer but a directive
   *  blocked acceptance. Reset on every other transition. After
   *  WINE_AGENT_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT consecutive ignores, the
   *  loop terminates (zombie-loop kill switch). */
  directiveIgnoredCount: number;
  /** Set once when the LLM emits an answer the contract accepts. */
  answer: string | undefined;
}

function makeInitialState(): RunnerState {
  return {
    steps: [],
    toolOutcomes: [],
    tokenUsage: makeZeroTokenUsage(),
    // Sentinel — overwritten on every real transition. The state machine
    // treats `max_steps` as "no real terminator recorded yet" (see
    // `termination-state-machine.ts`).
    terminationReason: 'max_steps',
    loopDetectedCount: 0,
    directiveIgnoredCount: 0,
    answer: undefined,
  };
}

// ---------------------------------------------------------------------------
// Logger seam
// ---------------------------------------------------------------------------

interface WineAgentLoopRunnerLogger {
  warn(payload: Record<string, unknown>, msg: string): void;
  info(payload: Record<string, unknown>, msg: string): void;
  error(payload: Record<string, unknown>, msg: string): void;
}

interface WineAgentLoopRunnerDeps {
  readonly structuredLlm: StructuredLlmPort;
  readonly logger?: WineAgentLoopRunnerLogger;
  /** Override of the Anthropic model id used for `execute`. Defaults to
   *  `WINE_AGENT_LOOP_DEFAULT_MODEL`. */
  readonly model?: string;
  /**
   * Optional Redis-backed memoization for (toolName, normalizedInput) →
   * result. When wired, the dispatcher checks the cache before executing
   * the tool and writes the result on miss. Absence (`undefined`) disables
   * caching at the wiring boundary — same semantics as
   * `WINE_SEARCH_TOOL_CACHE_ENABLED=0`. Cache failures are fail-open by
   * contract (see `ToolResultCachePort`).
   */
  readonly toolResultCache?: ToolResultCachePort | undefined;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class WineAgentLoopRunner {
  private readonly structuredLlm: StructuredLlmPort;
  private readonly logger: WineAgentLoopRunnerLogger;
  private readonly model: string;
  private readonly toolResultCache: ToolResultCachePort | undefined;
  /** Resolved once at runner construction; mirror the existing
   *  `DISABLED_TOOLS` pattern (snapshot env state at module/runner load). */
  private readonly toolCacheEnabled: boolean;

  constructor(deps: WineAgentLoopRunnerDeps) {
    this.structuredLlm = deps.structuredLlm;
    this.logger = deps.logger ?? defaultLog;
    this.model = deps.model ?? WINE_AGENT_LOOP_DEFAULT_MODEL;
    this.toolResultCache = deps.toolResultCache;
    this.toolCacheEnabled = readToolCacheEnabledEnv();
  }

  async run(input: WineAgentLoopInput): Promise<WineAgentLoopOutcome> {
    const state = makeInitialState();
    const copy = selectDirectiveCopy(input.analysis.hangulDominant);
    const agentConfig = buildAgentConfigFromInput(input);
    const budget = new StepBudget(agentConfig);

    let pendingDirective: WineAgentLoopDirective | undefined = input.initialDirective;
    // History grows with one entry per turn — kept short because the
    // adapter handles prompt caching of the static system prompt. Prior
    // conversation turns (multi-turn / session history) are seeded BEFORE
    // the anchor query so the agent LLM plans against the real context
    // (T-MTA-01: planner receives the full applied history, not just the
    // latest utterance).
    // The anchor is the CURRENT user query. We hold its reference so the
    // history trim can preserve it by identity — after the loop appends
    // tool-result `user` messages, "the last user message" is no longer the
    // anchor, so an index-based rule would evict the wrong one (T-MTA-07).
    const anchorMessage: ChatMessage = { role: 'user', content: input.query };
    const history: ChatMessage[] = [
      ...(input.priorHistory ?? []),
      anchorMessage,
    ];

    // ── Main loop. Single `for(;;)` with explicit `break`s on terminal
    // transitions. Following CLAUDE.md rule 19/20: every catch / loop
    // termination sets the reason via `transitionTerminationReason` BEFORE
    // breaking.
    for (;;) {
      // 1. Pre-flight step budget.
      const proceed = budget.canProceed();
      if (!proceed.allowed) {
        state.terminationReason = transitionTerminationReason(
          state.terminationReason,
          proceed.reason ?? 'max_steps',
        );
        break;
      }

      // 2. Token budget.
      const totalTokens = totalTokensOf(state.tokenUsage);
      if (totalTokens >= input.maxTotalTokens) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'budget');
        break;
      }

      // 3. Abort.
      if (input.abortSignal?.aborted === true) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
        break;
      }

      // 4. If a directive is pending, inject it as the next user message
      // BEFORE the LLM call. Per turn, at most one directive — the
      // observation-driven recomputation below decides whether one stays
      // pending.
      const promptHistory = pendingDirective !== undefined
        ? appendDirectiveMessage(history, pendingDirective, copy)
        : history;

      // 5. Execute one LLM turn.
      const stepStartedAtMs = Date.now();
      let stepResult: StepResult;
      try {
        stepResult = await this.runOneTurn(input, promptHistory, budget, copy, state.steps.length);
      } catch (err) {
        // Per-step abort / timeout / unknown LLM error. Map to the correct
        // termination reason and break — never swallow into an answer
        // (CLAUDE.md "schema quality bar" — catch blocks may not fabricate
        // 200 OK responses from unexpected errors).
        const reason: AgentTerminationReason = isAbortError(err)
          ? 'aborted'
          : isTimeoutLikeError(err)
            ? 'timeout'
            : 'error';
        const message = err instanceof Error ? err.message : String(err);
        state.terminationReason = transitionTerminationReason(state.terminationReason, reason);
        state.steps.push({
          index: state.steps.length,
          kind: 'error',
          reasoning: '',
          toolCalls: [],
          observations: [],
          toolOutcomes: [],
          errorReason: reason,
          errorMessage: message,
          durationMs: Math.max(0, Date.now() - stepStartedAtMs),
          tokenUsage: makeZeroTokenUsage(),
        });
        this.logger.warn(
          { requestId: input.requestId, err: message, reason, stepIndex: state.steps.length - 1 },
          '[WineAgentLoopRunner] step failed',
        );
        break;
      }

      // 6. Accumulate token usage (always — every LLM call counts).
      state.tokenUsage = addTokenUsage(state.tokenUsage, stepResult.tokenUsage);

      // 7. Branch on what the LLM produced.
      if (stepResult.kind === 'tool_use') {
        // 7a. Budget admission for the dispatched calls (atomic).
        const admit = budget.recordParallelBatch(
          stepResult.toolCalls.map((c) => ({ tool: c.tool, input: c.input })),
        );
        if (!admit.allowed) {
          state.loopDetectedCount += 1;
          // Surface an observation back to the model. If we've already hit
          // the terminate threshold, end the loop now (CLAUDE.md rule 19 —
          // a "stop processing" flag must be paired with control flow).
          if (state.loopDetectedCount >= WINE_AGENT_LOOP_LOOP_DETECTED_TERMINATE_COUNT) {
            state.terminationReason = transitionTerminationReason(
              state.terminationReason,
              admit.reason ?? 'loop_detected',
            );
            // Record an empty step describing the rejection so the trace
            // shows what happened.
            state.steps.push({
              index: state.steps.length,
              kind: 'error',
              reasoning: stepResult.reasoning,
              toolCalls: stepResult.toolCalls,
              observations: [copy.loopDetected],
              toolOutcomes: [],
              errorReason: admit.reason ?? 'loop_detected',
              errorMessage: copy.loopDetected,
              durationMs: Math.max(0, Date.now() - stepStartedAtMs),
              tokenUsage: stepResult.tokenUsage,
            });
            break;
          }
          // Otherwise, inject a loop-detected hint and let the model retry.
          history.push({ role: 'assistant', content: serializeAssistantToolCalls(stepResult.toolCalls) });
          history.push({ role: 'user', content: copy.loopDetected });
          pendingDirective = undefined;
          state.steps.push({
            index: state.steps.length,
            kind: 'error',
            reasoning: stepResult.reasoning,
            toolCalls: stepResult.toolCalls,
            observations: [copy.loopDetected],
            toolOutcomes: [],
            errorReason: admit.reason ?? 'loop_detected',
            errorMessage: copy.loopDetected,
            durationMs: Math.max(0, Date.now() - stepStartedAtMs),
            tokenUsage: stepResult.tokenUsage,
          });
          continue;
        }

        // 7b. Dispatch each call IN PARALLEL. Each dispatch owns its own
        // AbortController (chained to the shared abortSignal) and produces
        // an independent ToolOutcome — no shared mutable state between
        // dispatches. The shape mirrors ExecutionRunner.runParallelSearch.
        // Stepping serially here (the pre-F1-fix loop) tripled wall-clock
        // on multi-tool LLM turns (e.g. compare + 2× drinking_window).
        // Ordering of observations/toolOutcomes is preserved by index so
        // the chat-history append step downstream remains deterministic.
        // Adaptive retrieval k — feeds the active discovery primitives as the DEFAULT `limit`
        // when the LLM does not specify one. Sourced from
        // `analysis.recommendedBudget.retrievalK` which the query-analyzer
        // populated via `RETRIEVAL_K_BY_INTENT` (SSoT —
        // `adaptive-budget.ts`). Undefined for legacy callers that did not
        // populate the field; in that case the use case applies its own
        // default (no behavior change vs the pre-lever baseline).
        const adaptiveRetrievalKDefault = input.analysis.recommendedBudget.retrievalK;
        const dispatchResults = await Promise.all(
          stepResult.toolCalls.map((call, i) =>
            this.dispatchTool(
              call,
              input.toolPorts,
              input.requestId,
              state.steps.length,
              i,
              input.perStepTimeoutMs,
              input.abortSignal,
              adaptiveRetrievalKDefault,
            ),
          ),
        );
        const observations: string[] = [];
        const toolOutcomes: ToolOutcome[] = [];
        for (const r of dispatchResults) {
          observations.push(r.observation);
          toolOutcomes.push(r.outcome);
        }
        // Persist into rolling state.
        for (const outcome of toolOutcomes) state.toolOutcomes.push(outcome);

        const step: WineAgentLoopStep = {
          index: state.steps.length,
          kind: 'tool_use',
          reasoning: stepResult.reasoning,
          toolCalls: stepResult.toolCalls,
          observations,
          toolOutcomes,
          durationMs: Math.max(0, Date.now() - stepStartedAtMs),
          tokenUsage: stepResult.tokenUsage,
        };
        state.steps.push(step);
        // Reset directive-ignored counter — model corrected course by
        // making a tool call instead of a premature answer.
        state.directiveIgnoredCount = 0;

        // 7c. Extend chat history so the next turn sees the tool result.
        history.push({ role: 'assistant', content: serializeAssistantToolCalls(stepResult.toolCalls) });
        history.push({ role: 'user', content: serializeToolResults(stepResult.toolCalls, observations) });
        trimHistoryInPlace(history, anchorMessage);

        // 7d. Recompute the next directive FUNCTIONALLY from state +
        // analysis. This is the architectural fix — there's no sticky
        // pendingDirective on the runner instance.
        pendingDirective = computeNextDirective(input, state, copy);
        continue;
      }

      // 7e. Text turn — either a final answer or the model bailed.
      const trimmedAnswer = stepResult.text.trim();
      const step: WineAgentLoopStep = {
        index: state.steps.length,
        kind: 'answer',
        reasoning: stepResult.reasoning,
        toolCalls: [],
        observations: [],
        toolOutcomes: [],
        answer: trimmedAnswer.length > 0 ? trimmedAnswer : undefined,
        durationMs: Math.max(0, Date.now() - stepStartedAtMs),
        tokenUsage: stepResult.tokenUsage,
      };

      // Recompute directive BEFORE accepting the answer — if the contract
      // requires more work, the answer is rejected and the loop continues
      // with the directive injected (the zombie-loop fix).
      pendingDirective = computeNextDirective(input, state, copy);

      if (pendingDirective === undefined && trimmedAnswer.length > 0) {
        state.answer = trimmedAnswer;
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'answer');
        state.steps.push(step);
        state.directiveIgnoredCount = 0;
        break;
      }

      // Contract violation OR empty text — record and let the loop iterate.
      // We append the model's "premature answer" to history and surface the
      // directive as a user message on the NEXT iteration via the
      // pre-LLM-call injection above.
      state.steps.push(step);
      if (trimmedAnswer.length > 0) {
        history.push({ role: 'assistant', content: trimmedAnswer });
      }
      trimHistoryInPlace(history, anchorMessage);

      if (pendingDirective === undefined) {
        // Empty text AND no directive — there's nothing more to do.
        // Terminate now to prevent an infinite empty-answer loop.
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
        break;
      }

      // Zombie-loop kill switch (rule 19 — flag-set means stop processing):
      // if the model has refused to honor the directive
      // WINE_AGENT_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT consecutive times,
      // terminate with max_steps so the synthesizer can compose a degraded
      // response.
      state.directiveIgnoredCount += 1;
      if (state.directiveIgnoredCount >= WINE_AGENT_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'max_steps');
        break;
      }
      continue;
    }

    return {
      steps: state.steps,
      toolOutcomes: state.toolOutcomes,
      terminationReason: state.terminationReason,
      tokenUsage: state.tokenUsage,
      stoppedAtStep: state.steps.length,
      ...(state.answer !== undefined ? { answer: state.answer } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // One LLM turn — per-step timeout + abort propagation.
  // -------------------------------------------------------------------------

  private async runOneTurn(
    input: WineAgentLoopInput,
    history: readonly ChatMessage[],
    _budget: StepBudget,
    _copy: WineAgentLoopDirectiveCopy,
    stepIndex: number,
  ): Promise<StepResult> {
    throwIfAborted(input.abortSignal, 'WineAgentLoopRunner aborted before LLM call');

    // Per-step abort controller chained to the caller's signal.
    const local = new AbortController();
    const outerSignal = input.abortSignal;
    let cleanupListener: (() => void) | undefined;
    if (outerSignal !== undefined) {
      const onAbort = (): void => {
        local.abort(abortError(`WineAgentLoop step ${stepIndex} aborted by caller`));
      };
      if (outerSignal.aborted) {
        onAbort();
      } else {
        outerSignal.addEventListener('abort', onAbort);
        cleanupListener = (): void => { outerSignal.removeEventListener('abort', onAbort); };
      }
    }

    try {
      const request: ExecuteRequest = {
        messages: history,
        tools: input.tools,
        systemPrompt: WINE_AGENT_LOOP_SYSTEM_PROMPT,
        enablePromptCache: true,
        maxOutputTokens: input.maxOutputTokens,
        perStepTimeoutMs: input.perStepTimeoutMs,
        model: this.model,
        toolChoice: 'auto',
        abortSignal: local.signal,
      };
      const executed = await withTimeout(
        this.structuredLlm.execute(request),
        input.perStepTimeoutMs,
        `WineAgentLoop step ${stepIndex} timed out`,
      );
      return mapExecuteResult(executed);
    } finally {
      cleanupListener?.();
    }
  }

  // -------------------------------------------------------------------------
  // Tool dispatch — maps tool name → port + builds the outcome.
  // -------------------------------------------------------------------------

  private async dispatchTool(
    call: WineAgentLoopToolCall,
    ports: WineAgentLoopToolPorts,
    requestId: string,
    stepIndex: number,
    toolPosition: number,
    perStepTimeoutMs: number,
    abortSignal: AbortSignal | undefined,
    adaptiveRetrievalKDefault: number | undefined,
  ): Promise<{ readonly observation: string; readonly outcome: ToolOutcome }> {
    const startedAtMs = Date.now();

    // ── Pre-flight cache check. Skipped when:
    //    - cache port not wired,
    //    - env flag disables caching,
    //    - tool is in WINE_SEARCH_DISABLED_TOOLS (it would short-circuit to
    //      TOOL_UNAVAILABLE anyway — pointless to cache).
    //    - tool has no documented TTL (unknown tool — fail-safe: don't cache).
    // The cache.get() call is fail-open by port contract; an exception is
    // never raised into the dispatcher.
    const cacheKey = shouldConsultCache(this.toolResultCache, this.toolCacheEnabled, call.tool)
      ? { toolName: call.tool, normalizedInputHash: computeToolInputHash(call.input) }
      : undefined;
    if (cacheKey !== undefined && this.toolResultCache !== undefined) {
      const hit = await this.toolResultCache.get(cacheKey);
      if (hit !== null) {
        // Cache hit — reuse the stored result. Tag the observation with a
        // `[CACHE_HIT]` prefix so the judge / trace can distinguish cached
        // turns from fresh executions. Observation is recomputed from the
        // raw result (not stored) because the stored format normalizes
        // away the textual preview.
        const observation = `[CACHE_HIT] ${formatObservationForTool(call.tool, hit.result)}`;
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        const outcome = buildToolOutcome(
          requestId,
          stepIndex,
          toolPosition,
          call.tool,
          observation,
          hit.result,
          durationMs,
          /* execError */ false,
          /* timedOut */ false,
          /* policyViolation */ false,
        );
        return { observation, outcome };
      }
    }

    // Chain abort.
    const local = new AbortController();
    let cleanupListener: (() => void) | undefined;
    if (abortSignal !== undefined) {
      const onAbort = (): void => {
        local.abort(abortError(`WineAgentLoop tool "${call.tool}" aborted by caller`));
      };
      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener('abort', onAbort);
        cleanupListener = (): void => { abortSignal.removeEventListener('abort', onAbort); };
      }
    }

    let observation = '';
    let rawResult: unknown = null;
    let timedOut = false;
    let execError = false;
    try {
      const work = invokeToolPort(call, ports, requestId, local.signal, adaptiveRetrievalKDefault);
      const result = await withTimeout(
        work,
        perStepTimeoutMs,
        `WineAgentLoop tool "${call.tool}" timed out after ${perStepTimeoutMs}ms`,
      );
      rawResult = result.rawResult;
      observation = result.observation;
    } catch (err) {
      local.abort();
      const isTimeout = isTimeoutLikeError(err);
      if (isTimeout) {
        timedOut = true;
        observation = `Tool "${call.tool}" timed out after ${perStepTimeoutMs}ms`;
      } else {
        execError = true;
        observation = `Tool "${call.tool}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } finally {
      cleanupListener?.();
    }

    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const outcome = buildToolOutcome(
      requestId,
      stepIndex,
      toolPosition,
      call.tool,
      observation,
      rawResult,
      durationMs,
      execError,
      timedOut,
      /* policyViolation */ false,
    );

    // ── Cache write on miss. Only cache successful executions (no error,
    // no timeout, non-null result, has a documented TTL). Strip
    // non-deterministic fields before writing so repeat hits match
    // byte-for-byte where it matters for the LLM observation.
    //
    // Fire-and-forget: the set is fail-open by port contract; awaiting it
    // would add p95 latency for zero benefit (the LLM only consumes
    // `observation`/`outcome` — not the cache write ack).
    if (
      cacheKey !== undefined
      && this.toolResultCache !== undefined
      && !execError
      && !timedOut
      && rawResult !== null
    ) {
      const ttl = toolResultCacheTtlSeconds(call.tool);
      if (ttl !== undefined) {
        const sanitized = sanitizeResultForCache(rawResult);
        void this.toolResultCache.set(
          cacheKey,
          { result: sanitized, createdAt: Date.now() },
          ttl,
        ).catch((err: unknown) => {
          // Defensive — port contract guarantees no throw, but a buggy
          // adapter MUST NOT surface into the dispatch result. Log once
          // and move on.
          this.logger.warn(
            { err, tool: call.tool },
            '[WineAgentLoopRunner] tool cache write threw despite fail-open contract',
          );
        });
      }
    }

    return { observation, outcome };
  }
}

// ---------------------------------------------------------------------------
// Helpers — pure functions
// ---------------------------------------------------------------------------

function buildAgentConfigFromInput(input: WineAgentLoopInput): AgentConfig {
  // Mirrors AgentConfig shape so StepBudget gets exactly what it needs.
  // `seed` / `toolTimeoutMs` / `parallelBatchTimeoutMs` are intentionally
  // omitted (exactOptionalPropertyTypes — CLAUDE.md "TypeScript" rule).
  return {
    maxSteps: input.maxSteps,
    agentTimeoutMs: input.agentTimeoutMs,
    perStepTimeoutMs: input.perStepTimeoutMs,
    maxContextChars: WINE_AGENT_LOOP_MAX_HISTORY_CHARS,
    maxTotalTokens: input.maxTotalTokens,
  };
}

function totalTokensOf(usage: TokenUsage): number {
  // cacheReadTokens / cacheCreationTokens are also inputs from a billing
  // perspective; include them so the budget tracks real spend.
  const sum = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return Number.isFinite(sum) ? sum : 0;
}

function isTimeoutLikeError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const candidate = err as { code?: unknown; name?: unknown };
  if (typeof candidate.code === 'string' && candidate.code === 'TIMEOUT') return true;
  if (typeof candidate.name === 'string' && candidate.name === 'StructuredLlmTimeoutError') return true;
  return false;
}

// ---------------------------------------------------------------------------
// `ExecuteResult` → `StepResult` mapping
// ---------------------------------------------------------------------------

type StepResult =
  | {
      readonly kind: 'tool_use';
      readonly toolCalls: readonly WineAgentLoopToolCall[];
      readonly reasoning: string;
      readonly tokenUsage: TokenUsage;
    }
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly reasoning: string;
      readonly tokenUsage: TokenUsage;
    };

function mapExecuteResult(executed: ExecuteResult): StepResult {
  if (executed.kind === 'tool_use') {
    return {
      kind: 'tool_use',
      toolCalls: executed.calls.map((c: ToolUseCall) => ({ tool: c.name, input: c.input })),
      reasoning: '',
      tokenUsage: executed.usage,
    };
  }
  return {
    kind: 'text',
    text: executed.text,
    reasoning: executed.text,
    tokenUsage: executed.usage,
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch — translate the LLM's `tool_use` input into the
// runner-local use-case ports. We re-use the input schemas from
// `execution-plan-schemas.ts` (SSoT — CLAUDE.md rule 30) and only adapt
// the LLM-emitted shape (which uses snake_case) into the port shape (camelCase).
// ---------------------------------------------------------------------------

/**
 * Env-gated fail-closed set. When `WINE_SEARCH_DISABLED_TOOLS` is set to a
 * comma-separated list, those tools refuse with a clear observation
 * instead of dispatching to the underlying use case. Used to gate tools
 * with known structural defects (entity-route-dependent compare,
 * API-mismatched drinkability probe, empty food-pairing match) so the
 * LLM stops calling them and the bench's `mustNotCallTools` rubric on
 * out-of-domain doesn't get tripped by half-broken downstream tools.
 *
 * Read once at module load (deterministic & cheap); the bench harness
 * sets the env before the runner imports this module.
 */
const DISABLED_TOOLS: ReadonlySet<string> = new Set(
  (process.env['WINE_SEARCH_DISABLED_TOOLS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);
const FAIL_CLOSED_PREFIX = 'TOOL_UNAVAILABLE:';
const WINE_AGENT_LOOP_TOOL_FILTER_MAPPING_VERSION = 'wine_agent_loop_tool_v1' as const;

function invalidToolInputObservation(
  tool: string,
  issues: readonly string[],
): { readonly rawResult: null; readonly observation: string } {
  return {
    rawResult: null,
    observation: `Tool "${tool}" failed: invalid input — ${issues.join(', ')}`,
  };
}

/**
 * `adaptiveRetrievalKDefault` — the per-intent retrieval `k` derived from
 * `analysis.recommendedBudget.retrievalK` (SSoT `RETRIEVAL_K_BY_INTENT`
 * in `adaptive-budget.ts`). Applied as the DEFAULT `limit` for the
 * discovery primitives ONLY when the LLM-emitted tool input does NOT specify
 * its own `limit`. The LLM may intentionally use a different value for a
 * multi-hop reasoning step — we never override.
 *
 * `lookup_wine` is intentionally NOT threaded through the adaptive lever
 * because the tool contract caps `limit` at `LOOKUP_WINE_LIMIT_MAX` (= 3)
 * for high-precision identity resolution — broader recall would defeat
 * the tool's purpose.
 */
async function invokeToolPort(
  call: WineAgentLoopToolCall,
  ports: WineAgentLoopToolPorts,
  requestId: string,
  signal: AbortSignal,
  adaptiveRetrievalKDefault: number | undefined,
): Promise<{ readonly rawResult: unknown; readonly observation: string }> {
  // F-FailClosed: refuse without dispatch when the operator has marked
  // this tool as disabled via WINE_SEARCH_DISABLED_TOOLS. The observation
  // string is uniform so the LLM can detect "I cannot use this tool" and
  // pivot to an answer or a different tool without burning more steps.
  if (DISABLED_TOOLS.has(call.tool)) {
    return {
      rawResult: null,
      observation: `${FAIL_CLOSED_PREFIX} "${call.tool}" is currently disabled by the operator (WINE_SEARCH_DISABLED_TOOLS). Do NOT call it again. Use a different available tool, or commit an answer noting the limitation.`,
    };
  }
  switch (call.tool) {
    case 'search_hybrid':
    case 'search_semantic':
    case 'search_lexical': {
      // T-IR-05: the three discovery primitives share one input schema and
      // differ only in the retrieval lane, projected from the tool NAME via
      // the SSoT map. `semantic`/`lexical` skip the opposite candidate-pool
      // leg (see CandidatePoolService.applyRetrievalLaneFilter).
      const validation = SEARCH_PRIMITIVE_INPUT_SCHEMA.safeParse(sanitizeOptionalToolNulls(call.input));
      if (!validation.success) {
        return invalidToolInputObservation(
          call.tool,
          validation.error.issues.map((issue) => issue.message),
        );
      }
      const searchInput = adaptSearchInput(
        validation.data as Record<string, unknown>,
        adaptiveRetrievalKDefault,
        SEARCH_PRIMITIVE_TOOL_LANES[call.tool],
      );
      const result = await ports.searchUseCase.execute(searchInput, requestId, { abortSignal: signal });
      return { rawResult: result, observation: formatSearchObservation(result) };
    }
    case 'lookup_wine': {
      // High-precision identity resolution. SOLID H2: routed through the
      // shared `normalizeLookupWineInput` so the agent-tools branch and the
      // wine-agent-loop branch validate against the IDENTICAL schema (trim,
      // placeholder rejection, query length). Before extraction, this case
      // did a bare `typeof query === 'string'` check that silently accepted
      // " " or "__TODO__" — see SOLID H2 audit notes.
      //
      // mode='entity' restored after the entity-route anchor-refresh fix
      // landed (replaces the historical `lookup_wine → mode='hybrid'`
      // workaround from commit a344fe64). Entity-route anchors now recover
      // via the PlannerV1Adapter `anchorRefresh` hook when the planner
      // misses an alias the overlay holds — see
      // `src/domain/query/service/anchor-refresh.ts` and memory
      // `project_entity_route_broken`.
      const normalized = normalizeLookupWineInput(call.input);
      if (!normalized.ok) {
        return {
          rawResult: null,
          observation: `Tool "${call.tool}" failed: invalid input — ${normalized.message}`,
        };
      }
      const result = await ports.searchUseCase.execute(
        { query: normalized.query, mode: 'entity', limit: normalized.clampedLimit },
        requestId,
        { abortSignal: signal },
      );
      return { rawResult: result, observation: formatSearchObservation(result) };
    }
    case 'similar_to_entity': {
      // RFC-021 T-PSA-02: deterministic reference-similarity. The anchor
      // authority is `entity_id` (copied from a prior lookup_wine result),
      // NEVER a free-text name — the contract rejects free-text anchors. We
      // thread the resolved id as `anchorEntityId` so the SearchUseCaseAdapter
      // emits the path-authoritative `similar_to_entity` plan (route=mixed /
      // retrievalMode=similar_items) which excludes the seed entity in core.
      // `query` carries the id for provenance only; it never re-resolves the
      // anchor. Structured filters/preferences refine the set.
      const normalized = normalizeSimilarToEntityInput(call.input);
      if (!normalized.ok) {
        return {
          rawResult: null,
          observation: `Tool "${call.tool}" failed: invalid input — ${normalized.message}`,
        };
      }
      const result = await ports.searchUseCase.execute(
        {
          query: normalized.entityId,
          anchorEntityId: normalized.entityId,
          limit: normalized.clampedLimit,
          ...(normalized.filters.length > 0 ? { filters: [...normalized.filters] } : {}),
          ...(normalized.preferences.length > 0
            ? { preferences: [...normalized.preferences] }
            : {}),
        },
        requestId,
        { abortSignal: signal },
      );
      return { rawResult: result, observation: formatSearchObservation(result) };
    }
    default: {
      return {
        rawResult: null,
        observation: `Tool "${call.tool}" is not supported in the wine-agent-loop. Use one of: ${KNOWN_AGENT_TOOL_NAMES_DISPLAY}.`,
      };
    }
  }
}

/**
 * Wine-agent-loop's tool-input adapter for the discovery search primitives. Exported for direct
 * regression testing of the adaptive-k vs LLM-limit precedence rule. The
 * function is otherwise an implementation detail of `invokeToolPort` and
 * callers outside the runner SHOULD NOT depend on it.
 *
 * @internal
 */
export function adaptSearchInput(
  raw: Record<string, unknown>,
  adaptiveRetrievalKDefault: number | undefined,
  retrievalLane?: 'hybrid' | 'semantic_only' | 'lexical_only',
): SearchUseCaseInput {
  const built = buildSearchWinesToolUseCaseInput(raw, {
    mappingVersion: WINE_AGENT_LOOP_TOOL_FILTER_MAPPING_VERSION,
    adaptiveRetrievalKDefault,
    includeCallerInterpretation: true,
  });
  const { mode: _mode, ...laneScoped } = built;
  return {
    ...laneScoped,
    ...(laneScoped.filters !== undefined ? { filters: [...laneScoped.filters] } : {}),
    ...(laneScoped.preferences !== undefined ? { preferences: [...laneScoped.preferences] } : {}),
    // T-IR-05: the discovery primitive (search_hybrid/semantic/lexical) sets
    // the lane; the candidate pool gates channels accordingly. Omitted for
    // legacy/test callers that pass no lane (full hybrid mix).
    ...(retrievalLane !== undefined ? { retrievalLane } : {}),
  };
}




// ---------------------------------------------------------------------------
// Observation formatting — kept short to control token growth.
// ---------------------------------------------------------------------------

function formatSearchObservation(result: unknown): string {
  if (result === null || typeof result !== 'object') return formatGenericObservation('search', result);
  const record = result as Record<string, unknown>;
  const results = record['results'];
  if (!Array.isArray(results) || results.length === 0) {
    return `${WINE_AGENT_LOOP_NO_MATCH_PREFIX}search returned 0 results`;
  }
  const preview = results.slice(0, WINE_AGENT_LOOP_RESULT_PREVIEW_LIMIT)
    .map((r) => {
      if (r === null || typeof r !== 'object') return null;
      const entity = (r as Record<string, unknown>)['entity'];
      if (entity === null || typeof entity !== 'object') return null;
      const entityRecord = entity as Record<string, unknown>;
      const id = typeof entityRecord['entityId'] === 'string' ? entityRecord['entityId'] : 'unknown';
      const label = typeof entityRecord['canonicalLabel'] === 'string' ? entityRecord['canonicalLabel'] : id;
      return `${id}::${label}`;
    })
    .filter((s): s is string => s !== null);
  const body = `search: ${results.length} results; top=[${preview.join(', ')}]`;
  return clipObservation(body);
}

function formatGenericObservation(tool: string, result: unknown): string {
  if (result === null || result === undefined) return `${tool}: empty result`;
  try {
    return clipObservation(`${tool}: ${JSON.stringify(result)}`);
  } catch {
    return `${tool}: [unserializable result]`;
  }
}

function clipObservation(text: string): string {
  if (text.length <= WINE_AGENT_LOOP_RESULT_PREVIEW_CHARS) return text;
  return `${text.slice(0, WINE_AGENT_LOOP_RESULT_PREVIEW_CHARS)}…[truncated]`;
}

function serializeAssistantToolCalls(calls: readonly WineAgentLoopToolCall[]): string {
  if (calls.length === 0) return '[no tool calls]';
  return calls
    .map((c) => `tool=${c.tool} input=${safeJsonStringify(c.input)}`)
    .join('\n');
}

function serializeToolResults(
  calls: readonly WineAgentLoopToolCall[],
  observations: readonly string[],
): string {
  const lines: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const obs = observations[i] ?? '';
    if (call === undefined) continue;
    lines.push(`[tool_result name=${call.tool}] ${obs}`);
  }
  return lines.join('\n');
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}


// ---------------------------------------------------------------------------
// Tool-result cache helpers
// ---------------------------------------------------------------------------

/**
 * Env-gated kill switch for the tool-result cache. Read ONCE per
 * `WineAgentLoopRunner` construction (mirrors the `DISABLED_TOOLS` snapshot
 * pattern higher up in this file). Default ON; set to `'0'` to disable
 * entirely (e.g. for bench debugging).
 */
function readToolCacheEnabledEnv(): boolean {
  const raw = process.env['WINE_SEARCH_TOOL_CACHE_ENABLED'];
  if (raw === undefined) return true;
  return raw !== '0';
}

/**
 * True when the cache should be consulted/written for this tool call. The
 * three short-circuits (no cache wired, env-disabled, fail-closed tool) are
 * checked here so the dispatch site stays linear.
 */
function shouldConsultCache(
  cache: ToolResultCachePort | undefined,
  enabled: boolean,
  toolName: string,
): boolean {
  if (cache === undefined) return false;
  if (!enabled) return false;
  if (DISABLED_TOOLS.has(toolName)) return false;
  // A tool MUST have a documented TTL to participate. Unknown tools fall
  // through silently (caller treats `undefined` as "do not cache").
  if (toolResultCacheTtlSeconds(toolName) === undefined) return false;
  return true;
}

/**
 * Compute the truncated SHA-256 hex hash of a normalized tool input using
 * the SSoT `stableStringify`. The output is identical across processes and
 * matches what `RedisToolResultCache.computeInputHash` would produce.
 */
function computeToolInputHash(input: unknown): string {
  const canonical = stableStringify(input);
  return createHash('sha256').update(canonical).digest('hex').slice(0, TOOL_CACHE_INPUT_HASH_HEX_CHARS);
}

/**
 * Per-tool, light-weight observation reformatter for cache hits. The cached
 * record stores the raw result; the observation string is recomputed at
 * read time so it matches the format the LLM saw on first execution.
 */
function formatObservationForTool(toolName: string, result: unknown): string {
  switch (toolName) {
    case 'search_hybrid':
    case 'search_semantic':
    case 'search_lexical':
    case 'lookup_wine':
    case 'similar_to_entity':
      return formatSearchObservation(result);
    default:
      return formatGenericObservation(toolName, result);
  }
}

/**
 * Strip non-deterministic / request-bound fields from a tool result before
 * caching. Fields known to vary across otherwise-identical calls (e.g.
 * `meta.generatedAt` ISO timestamps, any embedded `requestId` /
 * `request_id`) are removed so that subsequent cache hits return a stable
 * payload. This is intentionally conservative — we only strip well-known
 * sentinel fields; the per-tool projector grows on demand.
 */
function sanitizeResultForCache(result: unknown): unknown {
  if (result === null || typeof result !== 'object') return result;
  if (Array.isArray(result)) return result.map(sanitizeResultForCache);
  const obj = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    // Drop top-level request-bound markers.
    if (k === 'requestId' || k === 'request_id') continue;
    const v = obj[k];
    if (k === 'meta' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Drop `meta.generatedAt` — recomputed on every response (ISO ts).
      const meta = v as Record<string, unknown>;
      const cleanedMeta: Record<string, unknown> = {};
      for (const mk of Object.keys(meta)) {
        if (mk === 'generatedAt' || mk === 'generated_at') continue;
        cleanedMeta[mk] = meta[mk];
      }
      out[k] = cleanedMeta;
      continue;
    }
    out[k] = sanitizeResultForCache(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Functional directive computation — the centerpiece of the zombie-loop
// fix. Pure function of (analysis, current state). Never reads from the
// LLM message; never sets sticky state.
// ---------------------------------------------------------------------------

export function computeNextDirective(
  input: WineAgentLoopInput,
  state: RunnerStateView,
  copy: WineAgentLoopDirectiveCopy,
): WineAgentLoopDirective | undefined {
  const contract = input.analysis.contract;
  const outcomes = state.toolOutcomes;

  // Helpers — small inline because they're only used here.
  const hasOutcome = (tool: string): boolean => outcomes.some((o) => o.tool === tool);
  const hasAnySearchOutcome = (): boolean => outcomes.some((o) => isSearchPrimitiveToolName(o.tool));
  const lastSearchOutcome = (): ToolOutcome | undefined => {
    for (let i = outcomes.length - 1; i >= 0; i--) {
      const o = outcomes[i];
      if (o !== undefined && isSearchPrimitiveToolName(o.tool)) return o;
    }
    return undefined;
  };
  // 1. Grounded search required + no search yet. Any discovery primitive
  //    (search_hybrid/semantic/lexical) satisfies the grounded-search gate.
  if (contract.requiresGroundedWineSearch && !hasAnySearchOutcome()) {
    return { kind: 'grounded_search_required', instruction: copy.groundedSearch };
  }

  // 2. Required tool not yet called.
  if (
    contract.requiredTool !== undefined
    && !hasOutcome(contract.requiredTool)
  ) {
    return {
      kind: 'required_tool',
      tool: contract.requiredTool,
      instruction: copy.requiredTool(contract.requiredTool),
    };
  }

  // 4. Relax constraints — fire when the last search returned 0 results
  // AND we have not yet attempted a relax retry.
  const lastSearch = lastSearchOutcome();
  if (
    lastSearch?.kind === 'empty_result'
    && hasRelaxableConstraints(input.analysis)
    && !alreadyRetriedRelax(state)
  ) {
    return {
      kind: 'relax_constraints_retry',
      relaxableConstraintAttributes: [...collectRelaxableAttributes(input.analysis)],
      instruction: copy.relax,
    };
  }

  return undefined;
}

interface RunnerStateView {
  readonly toolOutcomes: readonly ToolOutcome[];
  readonly steps: readonly WineAgentLoopStep[];
}

function hasRelaxableConstraints(analysis: WineAgentLoopInput['analysis']): boolean {
  // Non-must-have constraints are eligible for relaxation. The
  // WineSearchAnalysis schema marks must-have via `mustHave: true` on each
  // NormalizedConstraint. Anything without `mustHave === true` is
  // relaxable.
  return getCanonicalNormalizedConstraints(analysis).some((c) => {
    const record = c as Record<string, unknown>;
    return record['mustHave'] !== true;
  });
}

function collectRelaxableAttributes(analysis: WineAgentLoopInput['analysis']): readonly string[] {
  const attrs: string[] = [];
  for (const c of getCanonicalNormalizedConstraints(analysis)) {
    const record = c as Record<string, unknown>;
    if (record['mustHave'] === true) continue;
    const attribute = record['attribute'];
    if (typeof attribute === 'string' && attribute.length > 0) attrs.push(attribute);
  }
  // De-dupe while preserving order.
  return Array.from(new Set(attrs)).slice(0, WINE_AGENT_LOOP_MAX_DRINKABILITY_ENTITY_IDS);
}

function alreadyRetriedRelax(state: RunnerStateView): boolean {
  // The runner doesn't keep a sticky "retried" flag — instead we infer it
  // from the trace: count how many distinct search calls we've made. ≥2
  // means we've already done at least one relax pass.
  let searchCount = 0;
  for (const o of state.toolOutcomes) {
    if (isSearchPrimitiveToolName(o.tool)) searchCount += 1;
  }
  return searchCount >= 2;
}



// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

function appendDirectiveMessage(
  history: readonly ChatMessage[],
  directive: WineAgentLoopDirective,
  _copy: WineAgentLoopDirectiveCopy,
): readonly ChatMessage[] {
  // The directive carries its own (locale-aware) instruction string.
  return [...history, { role: 'user', content: `[directive] ${directive.instruction}` }];
}

function trimHistoryInPlace(history: ChatMessage[], anchor: ChatMessage): void {
  // Drop the oldest non-initial user message when total chars overflow.
  // First message (the user's original query) is preserved as the loop's
  // anchor.
  //
  // F6: was O(N²) — every `tail.shift()` was paired with a full re-sum of
  // the remaining tail. We now maintain `total` incrementally and use a
  // head-index pointer instead of repeated `shift()` (which is itself O(N)
  // on arrays). Final write-back uses one slice + array assignment so the
  // observable behaviour is unchanged.
  let total = 0;
  for (const m of history) total += m.content.length;
  if (total <= WINE_AGENT_LOOP_MAX_HISTORY_CHARS) return;

  if (history[0] === undefined) return;

  // ALWAYS retain `head` (index 0) and the `anchor` (the current user query,
  // identified BY REFERENCE — its index shifts as the loop appends tool-result
  // `user` messages, so a positional "last user message" rule would pin the
  // wrong one, T-MTA-07). Evict the oldest OTHER messages first (prior turns
  // before the recent tail). In the single-turn case the anchor IS the head,
  // so this degrades to the original "keep head + recent".
  const evicted = new Set<number>();
  for (let i = 1; i < history.length && total > WINE_AGENT_LOOP_MAX_HISTORY_CHARS; i += 1) {
    if (history[i] === anchor) continue; // never evict the anchor
    total -= history[i]!.content.length;
    evicted.add(i);
  }

  if (evicted.size > 0) {
    const kept = history.filter((_, i) => !evicted.has(i));
    history.length = 0;
    for (const m of kept) history.push(m);
  }
  if (history.length === 1) {
    history.push({ role: 'user', content: WINE_AGENT_LOOP_HISTORY_TRUNCATION_TAIL });
  }
}
