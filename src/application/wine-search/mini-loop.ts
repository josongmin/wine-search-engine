/**
 * MiniLoopRunner — the lean ReAct loop for genuinely multi-hop queries.
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
 *     `MINI_LOOP_LOOP_DETECTED_TERMINATE_COUNT` rejections the loop
 *     terminates.
 *  4. Per-step timeout is enforced via `withTimeout`
 *     (SSoT — `agent-tool-execution-support.ts`). Abort listeners are
 *     cleaned up in `finally`.
 *  5. `enablePromptCache: true` is passed on every `execute` request so the
 *     static system prompt + tool defs are cached after the first turn.
 *  6. Tool dispatch uses `buildToolOutcome`
 *     (SSoT — `agent-tool-execution-support.ts`). No fabricated outcomes.
 *  7. Directive copy is Korean when `analysis.hangulDominant`, English
 *     otherwise (CLAUDE.md i18n discipline — see `mini-loop-schemas.ts`).
 */

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
import { LOOKUP_WINE_LIMIT_MAX } from '../search/search-tool-contract.js';
import {
  addTokenUsage,
  makeZeroTokenUsage,
} from './synthesis-schemas.js';
import {
  MINI_LOOP_DEFAULT_MODEL,
  MINI_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT,
  MINI_LOOP_LOOP_DETECTED_TERMINATE_COUNT,
  MINI_LOOP_MAX_DRINKABILITY_ENTITY_IDS,
  selectDirectiveCopy,
  type MiniLoopDirective,
  type MiniLoopDirectiveCopy,
  type MiniLoopInput,
  type MiniLoopOutcome,
  type MiniLoopStep,
  type MiniLoopToolCall,
  type MiniLoopToolPorts,
} from './mini-loop-schemas.js';
import type {
  ComparisonUseCaseInput,
  FoodPairingUseCaseInput,
  SearchUseCaseInput,
} from './execution-plan-schemas.js';

const defaultLog = bootstrapLogger.child({ component: 'MiniLoopRunner' });

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Maximum size of the rolling chat history sent to the LLM, in characters.
 *  Keeps the per-step token cost predictable when the model emits chatty
 *  observations. */
const MINI_LOOP_MAX_HISTORY_CHARS = 12_000;

/** Truncation tail appended when the rolling history is clipped. */
const MINI_LOOP_HISTORY_TRUNCATION_TAIL = '\n…[mini-loop history truncated]';

/** Empty-result string used by `buildToolOutcome` to classify
 *  `empty_result`. Mirrors the format produced by agent tools (search
 *  returning zero results). */
const MINI_LOOP_NO_MATCH_PREFIX = 'NO_MATCH: ';

/** Maximum number of result items we serialize back to the LLM per tool
 *  outcome. Search responses can be long; we only need the top few to
 *  drive the next reasoning step. */
const MINI_LOOP_RESULT_PREVIEW_LIMIT = 5;

/** Magnitude that triggers the "result preview truncated" suffix in the
 *  observation. */
const MINI_LOOP_RESULT_PREVIEW_CHARS = 1_500;

// ---------------------------------------------------------------------------
// System prompt — static so it benefits from prompt caching.
// ---------------------------------------------------------------------------

const MINI_LOOP_SYSTEM_PROMPT = [
  'You are a wine search agent driving a small, focused ReAct loop.',
  '',
  'Available tools:',
  '  - search_wines: retrieve wines matching the query and constraints.',
  '  - lookup_wine: resolve ONE specific wine by name/identity (1-3 exact matches); use instead of search_wines when the user names a particular wine.',
  '  - get_food_pairings: retrieve wines that pair with a food description.',
  '  - check_drinking_window: evaluate drinkability of a specific wine entity at a target year.',
  '  - compare_wines: compare two wine descriptors.',
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
  readonly steps: MiniLoopStep[];
  readonly toolOutcomes: ToolOutcome[];
  tokenUsage: TokenUsage;
  terminationReason: AgentTerminationReason;
  loopDetectedCount: number;
  /** Consecutive turns where the model emitted an answer but a directive
   *  blocked acceptance. Reset on every other transition. After
   *  MINI_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT consecutive ignores, the
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

export interface MiniLoopRunnerLogger {
  warn(payload: Record<string, unknown>, msg: string): void;
  info(payload: Record<string, unknown>, msg: string): void;
  error(payload: Record<string, unknown>, msg: string): void;
}

export interface MiniLoopRunnerDeps {
  readonly structuredLlm: StructuredLlmPort;
  readonly logger?: MiniLoopRunnerLogger;
  /** Override of the Anthropic model id used for `execute`. Defaults to
   *  `MINI_LOOP_DEFAULT_MODEL`. */
  readonly model?: string;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class MiniLoopRunner {
  private readonly structuredLlm: StructuredLlmPort;
  private readonly logger: MiniLoopRunnerLogger;
  private readonly model: string;

  constructor(deps: MiniLoopRunnerDeps) {
    this.structuredLlm = deps.structuredLlm;
    this.logger = deps.logger ?? defaultLog;
    this.model = deps.model ?? MINI_LOOP_DEFAULT_MODEL;
  }

  async run(input: MiniLoopInput): Promise<MiniLoopOutcome> {
    const state = makeInitialState();
    const copy = selectDirectiveCopy(input.analysis.hangulDominant);
    const agentConfig = buildAgentConfigFromInput(input);
    const budget = new StepBudget(agentConfig);

    let pendingDirective: MiniLoopDirective | undefined = input.initialDirective;
    // History grows with one entry per turn — kept short because the
    // adapter handles prompt caching of the static system prompt.
    const history: ChatMessage[] = [
      { role: 'user', content: input.query },
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
          '[MiniLoopRunner] step failed',
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
          if (state.loopDetectedCount >= MINI_LOOP_LOOP_DETECTED_TERMINATE_COUNT) {
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

        // 7b. Dispatch each call. Tool outcomes accumulate into the step.
        const observations: string[] = [];
        const toolOutcomes: ToolOutcome[] = [];
        for (let i = 0; i < stepResult.toolCalls.length; i++) {
          const call = stepResult.toolCalls[i];
          if (call === undefined) continue;
          const dispatched = await this.dispatchTool(
            call,
            input.toolPorts,
            input.requestId,
            state.steps.length,
            i,
            input.perStepTimeoutMs,
            input.abortSignal,
          );
          observations.push(dispatched.observation);
          toolOutcomes.push(dispatched.outcome);
        }
        // Persist into rolling state.
        for (const outcome of toolOutcomes) state.toolOutcomes.push(outcome);

        const step: MiniLoopStep = {
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
        trimHistoryInPlace(history);

        // 7d. Recompute the next directive FUNCTIONALLY from state +
        // analysis. This is the architectural fix — there's no sticky
        // pendingDirective on the runner instance.
        pendingDirective = computeNextDirective(input, state, copy);
        continue;
      }

      // 7e. Text turn — either a final answer or the model bailed.
      const trimmedAnswer = stepResult.text.trim();
      const step: MiniLoopStep = {
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
      trimHistoryInPlace(history);

      if (pendingDirective === undefined) {
        // Empty text AND no directive — there's nothing more to do.
        // Terminate now to prevent an infinite empty-answer loop.
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
        break;
      }

      // Zombie-loop kill switch (rule 19 — flag-set means stop processing):
      // if the model has refused to honor the directive
      // MINI_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT consecutive times,
      // terminate with max_steps so the synthesizer can compose a degraded
      // response.
      state.directiveIgnoredCount += 1;
      if (state.directiveIgnoredCount >= MINI_LOOP_DIRECTIVE_IGNORED_TERMINATE_COUNT) {
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
    input: MiniLoopInput,
    history: readonly ChatMessage[],
    _budget: StepBudget,
    _copy: MiniLoopDirectiveCopy,
    stepIndex: number,
  ): Promise<StepResult> {
    throwIfAborted(input.abortSignal, 'MiniLoopRunner aborted before LLM call');

    // Per-step abort controller chained to the caller's signal.
    const local = new AbortController();
    const outerSignal = input.abortSignal;
    let cleanupListener: (() => void) | undefined;
    if (outerSignal !== undefined) {
      const onAbort = (): void => {
        local.abort(abortError(`MiniLoop step ${stepIndex} aborted by caller`));
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
        systemPrompt: MINI_LOOP_SYSTEM_PROMPT,
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
        `MiniLoop step ${stepIndex} timed out`,
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
    call: MiniLoopToolCall,
    ports: MiniLoopToolPorts,
    requestId: string,
    stepIndex: number,
    toolPosition: number,
    perStepTimeoutMs: number,
    abortSignal: AbortSignal | undefined,
  ): Promise<{ readonly observation: string; readonly outcome: ToolOutcome }> {
    const startedAtMs = Date.now();

    // Chain abort.
    const local = new AbortController();
    let cleanupListener: (() => void) | undefined;
    if (abortSignal !== undefined) {
      const onAbort = (): void => {
        local.abort(abortError(`MiniLoop tool "${call.tool}" aborted by caller`));
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
      const work = invokeToolPort(call, ports, requestId, local.signal);
      const result = await withTimeout(
        work,
        perStepTimeoutMs,
        `MiniLoop tool "${call.tool}" timed out after ${perStepTimeoutMs}ms`,
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
    return { observation, outcome };
  }
}

// ---------------------------------------------------------------------------
// Helpers — pure functions
// ---------------------------------------------------------------------------

function buildAgentConfigFromInput(input: MiniLoopInput): AgentConfig {
  // Mirrors AgentConfig shape so StepBudget gets exactly what it needs.
  // `seed` / `toolTimeoutMs` / `parallelBatchTimeoutMs` are intentionally
  // omitted (exactOptionalPropertyTypes — CLAUDE.md "TypeScript" rule).
  return {
    maxSteps: input.maxSteps,
    agentTimeoutMs: input.agentTimeoutMs,
    perStepTimeoutMs: input.perStepTimeoutMs,
    maxContextChars: MINI_LOOP_MAX_HISTORY_CHARS,
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
      readonly toolCalls: readonly MiniLoopToolCall[];
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

async function invokeToolPort(
  call: MiniLoopToolCall,
  ports: MiniLoopToolPorts,
  requestId: string,
  signal: AbortSignal,
): Promise<{ readonly rawResult: unknown; readonly observation: string }> {
  switch (call.tool) {
    case 'search_wines': {
      const searchInput = adaptSearchInput(call.input);
      const result = await ports.searchUseCase.execute(searchInput, requestId, { abortSignal: signal });
      return { rawResult: result, observation: formatSearchObservation(result) };
    }
    case 'lookup_wine': {
      // High-precision identity resolution: force the entity route, clamp to a
      // tight result set, ignore any constraint filters the LLM may have added.
      const query = typeof call.input['query'] === 'string' ? call.input['query'] : '';
      const rawLimit = typeof call.input['limit'] === 'number' && Number.isFinite(call.input['limit'])
        ? call.input['limit']
        : LOOKUP_WINE_LIMIT_MAX;
      const result = await ports.searchUseCase.execute(
        { query, mode: 'entity', limit: Math.min(rawLimit, LOOKUP_WINE_LIMIT_MAX) },
        requestId,
        { abortSignal: signal },
      );
      return { rawResult: result, observation: formatSearchObservation(result) };
    }
    case 'get_food_pairings': {
      const pairingInput = adaptFoodPairingInput(call.input);
      const result = await ports.foodPairingUseCase.execute(pairingInput, requestId, { abortSignal: signal });
      return { rawResult: result.results, observation: formatSearchObservation(result.results) };
    }
    case 'compare_wines': {
      const comparisonInput = adaptComparisonInput(call.input);
      const result = await ports.comparisonUseCase.execute(comparisonInput, requestId, { abortSignal: signal });
      return { rawResult: result, observation: formatGenericObservation('compare_wines', result) };
    }
    case 'check_drinking_window': {
      const { entityId, targetYear } = adaptDrinkabilityInput(call.input);
      const probe = await ports.drinkabilityUseCase.probe(entityId, targetYear, requestId, { abortSignal: signal });
      if (probe === undefined) {
        return {
          rawResult: null,
          observation: `${MINI_LOOP_NO_MATCH_PREFIX}check_drinking_window: no drinkability projection for "${entityId}"`,
        };
      }
      return { rawResult: probe, observation: formatGenericObservation('check_drinking_window', probe) };
    }
    default: {
      return {
        rawResult: null,
        observation: `Tool "${call.tool}" is not supported in the mini-loop. Use one of: search_wines, lookup_wine, get_food_pairings, check_drinking_window, compare_wines.`,
      };
    }
  }
}

function adaptSearchInput(raw: Record<string, unknown>): SearchUseCaseInput {
  const query = typeof raw['query'] === 'string' && raw['query'].length > 0
    ? raw['query']
    : '';
  // We intentionally keep the surface minimal — the runner trusts the
  // LLM's query and forwards filters/preferences when present. Bounds are
  // enforced downstream by the use case port itself.
  return {
    query,
    ...(Array.isArray(raw['filters']) ? { filters: raw['filters'] as SearchUseCaseInput['filters'] } : {}),
    ...(Array.isArray(raw['preferences']) ? { preferences: raw['preferences'] as SearchUseCaseInput['preferences'] } : {}),
    ...(typeof raw['mode'] === 'string' ? { mode: raw['mode'] as SearchUseCaseInput['mode'] } : {}),
    ...(typeof raw['limit'] === 'number' && Number.isFinite(raw['limit']) ? { limit: raw['limit'] } : {}),
  };
}

function adaptFoodPairingInput(raw: Record<string, unknown>): FoodPairingUseCaseInput {
  const food = typeof raw['food'] === 'string' ? raw['food'] : '';
  return {
    food,
    ...(typeof raw['color'] === 'string' ? { color: raw['color'] as FoodPairingUseCaseInput['color'] } : {}),
    ...(Array.isArray(raw['styles'])
      ? { styles: filterStrings(raw['styles']) }
      : {}),
    ...(Array.isArray(raw['pairing_tags'])
      ? { pairingTags: filterStrings(raw['pairing_tags']) }
      : {}),
    ...(typeof raw['max_price_krw'] === 'number' && Number.isFinite(raw['max_price_krw'])
      ? { maxPriceKrw: raw['max_price_krw'] }
      : {}),
  };
}

function adaptComparisonInput(raw: Record<string, unknown>): ComparisonUseCaseInput {
  const queryA = typeof raw['query_a'] === 'string' ? raw['query_a'] : '';
  const queryB = typeof raw['query_b'] === 'string' ? raw['query_b'] : '';
  return {
    originalQuery: `${queryA} vs ${queryB}`,
    intent: 'compare',
    legs: [
      { surface: queryA, constraints: [] },
      { surface: queryB, constraints: [] },
    ],
  };
}

function adaptDrinkabilityInput(raw: Record<string, unknown>): { readonly entityId: string; readonly targetYear: number } {
  const entityId = typeof raw['entity_id'] === 'string' ? raw['entity_id'] : '';
  const targetYearRaw = raw['target_year'];
  // CLAUDE.md schema-quality bar: parseFloat / Number on external input
  // must be guarded with Number.isFinite.
  const parsedYear = typeof targetYearRaw === 'number'
    ? targetYearRaw
    : typeof targetYearRaw === 'string'
      ? parseFloat(targetYearRaw)
      : NaN;
  const targetYear = Number.isFinite(parsedYear) ? parsedYear : new Date().getUTCFullYear();
  return { entityId, targetYear };
}

// ---------------------------------------------------------------------------
// Observation formatting — kept short to control token growth.
// ---------------------------------------------------------------------------

function formatSearchObservation(result: unknown): string {
  if (result === null || typeof result !== 'object') return formatGenericObservation('search', result);
  const record = result as Record<string, unknown>;
  const results = record['results'];
  if (!Array.isArray(results) || results.length === 0) {
    return `${MINI_LOOP_NO_MATCH_PREFIX}search returned 0 results`;
  }
  const preview = results.slice(0, MINI_LOOP_RESULT_PREVIEW_LIMIT)
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
  if (text.length <= MINI_LOOP_RESULT_PREVIEW_CHARS) return text;
  return `${text.slice(0, MINI_LOOP_RESULT_PREVIEW_CHARS)}…[truncated]`;
}

function serializeAssistantToolCalls(calls: readonly MiniLoopToolCall[]): string {
  if (calls.length === 0) return '[no tool calls]';
  return calls
    .map((c) => `tool=${c.tool} input=${safeJsonStringify(c.input)}`)
    .join('\n');
}

function serializeToolResults(
  calls: readonly MiniLoopToolCall[],
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

function filterStrings(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Functional directive computation — the centerpiece of the zombie-loop
// fix. Pure function of (analysis, current state). Never reads from the
// LLM message; never sets sticky state.
// ---------------------------------------------------------------------------

export function computeNextDirective(
  input: MiniLoopInput,
  state: RunnerStateView,
  copy: MiniLoopDirectiveCopy,
): MiniLoopDirective | undefined {
  const contract = input.analysis.contract;
  const outcomes = state.toolOutcomes;

  // Helpers — small inline because they're only used here.
  const hasOutcome = (tool: string): boolean => outcomes.some((o) => o.tool === tool);
  const lastSearchOutcome = (): ToolOutcome | undefined => {
    for (let i = outcomes.length - 1; i >= 0; i--) {
      const o = outcomes[i];
      if (o !== undefined && (o.tool === 'search_wines' || o.tool === 'get_food_pairings')) return o;
    }
    return undefined;
  };
  const drinkabilityDone = (entityId: string): boolean =>
    outcomes.some(
      (o) =>
        o.tool === 'check_drinking_window'
        && (o.kind === 'success' || o.kind === 'partial_result')
        && resultRefersToEntity(o.result, entityId),
    );

  // 1. Grounded search required + no search yet.
  if (contract.requiresGroundedWineSearch && !hasOutcome('search_wines')) {
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

  // 3. Pending drinkability check after a search returned entity ids.
  if (contract.requiresDrinkabilityCheck) {
    const last = lastSearchOutcome();
    if (last !== undefined && last.kind === 'success') {
      const entityIds = extractEntityIds(last.result, MINI_LOOP_MAX_DRINKABILITY_ENTITY_IDS);
      const missing = entityIds.filter((id) => !drinkabilityDone(id));
      if (missing.length > 0) {
        return {
          kind: 'pending_drinkability_check',
          entityIds: missing,
          instruction: copy.pendingDrinkability(missing),
        };
      }
    }
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
  readonly steps: readonly MiniLoopStep[];
}

function hasRelaxableConstraints(analysis: MiniLoopInput['analysis']): boolean {
  // Non-must-have constraints are eligible for relaxation. The
  // WineSearchAnalysis schema marks must-have via `mustHave: true` on each
  // NormalizedConstraint. Anything without `mustHave === true` is
  // relaxable.
  return analysis.normalizedConstraints.some((c) => {
    const record = c as Record<string, unknown>;
    return record['mustHave'] !== true;
  });
}

function collectRelaxableAttributes(analysis: MiniLoopInput['analysis']): readonly string[] {
  const attrs: string[] = [];
  for (const c of analysis.normalizedConstraints) {
    const record = c as Record<string, unknown>;
    if (record['mustHave'] === true) continue;
    const attribute = record['attribute'];
    if (typeof attribute === 'string' && attribute.length > 0) attrs.push(attribute);
  }
  // De-dupe while preserving order.
  return Array.from(new Set(attrs)).slice(0, MINI_LOOP_MAX_DRINKABILITY_ENTITY_IDS);
}

function alreadyRetriedRelax(state: RunnerStateView): boolean {
  // The runner doesn't keep a sticky "retried" flag — instead we infer it
  // from the trace: count how many distinct search calls we've made. ≥2
  // means we've already done at least one relax pass.
  let searchCount = 0;
  for (const o of state.toolOutcomes) {
    if (o.tool === 'search_wines') searchCount += 1;
  }
  return searchCount >= 2;
}

function extractEntityIds(result: unknown, max: number): readonly string[] {
  if (result === null || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  const results = record['results'];
  if (!Array.isArray(results)) return [];
  const ids: string[] = [];
  for (const item of results) {
    if (item === null || typeof item !== 'object') continue;
    const entity = (item as Record<string, unknown>)['entity'];
    if (entity === null || typeof entity !== 'object') continue;
    const entityRecord = entity as Record<string, unknown>;
    const id = entityRecord['entityId'];
    if (typeof id === 'string' && id.length > 0) ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
}

function resultRefersToEntity(result: unknown, entityId: string): boolean {
  if (result === null || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if (typeof record['entityId'] === 'string' && record['entityId'] === entityId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

function appendDirectiveMessage(
  history: readonly ChatMessage[],
  directive: MiniLoopDirective,
  _copy: MiniLoopDirectiveCopy,
): readonly ChatMessage[] {
  // The directive carries its own (locale-aware) instruction string.
  return [...history, { role: 'user', content: `[directive] ${directive.instruction}` }];
}

function trimHistoryInPlace(history: ChatMessage[]): void {
  // Drop the oldest non-initial user message when total chars overflow.
  // First message (the user's original query) is preserved as the loop's
  // anchor.
  let total = 0;
  for (const m of history) total += m.content.length;
  if (total <= MINI_LOOP_MAX_HISTORY_CHARS) return;

  // Keep the first message; trim from the front of the rest.
  const head = history[0];
  if (head === undefined) return;
  const tail = history.slice(1);
  while (tail.length > 0) {
    total = head.content.length;
    for (const m of tail) total += m.content.length;
    if (total <= MINI_LOOP_MAX_HISTORY_CHARS) break;
    tail.shift();
  }
  history.length = 0;
  history.push(head);
  for (const m of tail) history.push(m);
  if (history.length === 1) {
    history.push({ role: 'user', content: MINI_LOOP_HISTORY_TRUNCATION_TAIL });
  }
}
