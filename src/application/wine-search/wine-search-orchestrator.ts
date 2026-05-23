/**
 * WineSearchOrchestrator — top-level composition root for the Plan-then-Execute
 * wine-search pipeline.
 *
 * Wires the four standalone runners into a single async `execute()` method:
 *
 *   admit gate ─► QueryAnalyzer ─► DeterministicRouter
 *                                      │
 *                              ┌───────┴───────┐
 *                       multi-step           other plans
 *                              │                   │
 *                        MiniLoopRunner     ExecutionRunner
 *                              │                   │
 *                              └────────┬──────────┘
 *                                       ▼
 *                                SynthesisRunner
 *                                       │
 *                                       ▼
 *                                WineSearchResult
 *
 * The orchestrator is the only Plan-then-Execute component that owns
 * end-to-end concerns:
 *  - admit gate (empty-query / over-length / aborted) — ports the semantics
 *    of {@link admitAgentRequest} without importing it (additive only).
 *  - per-phase tracing (`ExecutionStep[]`),
 *  - cumulative token-usage accounting,
 *  - cumulative termination-reason via {@link transitionTerminationReason}
 *    (SSoT — CLAUDE.md rule 30 — every reason write goes through it),
 *  - abort-signal propagation with a pre-flight check BEFORE every async
 *    boundary and a wrap on every catch path,
 *  - runtime validation of the final result against
 *    {@link WineSearchResultSchema} (CLAUDE.md schema-quality bar — no
 *    fabricated success-shaped outputs from unknown errors).
 *
 * The orchestrator does **not** know about:
 *  - HTTP wire formats (Track B owns the route handler),
 *  - DI container wiring (Track C owns container.ts registration),
 *  - tool-port construction (callers supply `miniLoopToolBundle` when a
 *    `multi-step` plan is possible; absent that, the orchestrator falls back
 *    to the synthesizer with empty tool outcomes).
 *
 * No existing files are modified by this module — it is purely additive.
 */

import type { AgentConfig } from '@domain/agent/model/agent-config.js';
import { DEFAULT_AGENT_CONFIG } from '@domain/agent/model/agent-config.js';
import type { AgentTerminationReason } from '@domain/agent/model/agent-step.js';
import type { ToolOutcome } from '@domain/agent/model/tool-outcome.js';
import { transitionTerminationReason } from '@domain/agent/service/termination-state-machine.js';
import type { TokenUsage, ToolDefinition } from '@domain/ai/port/structured-llm.port.js';
import { bootstrapLogger } from '@domain/shared/bootstrap-logger.js';
import { isAbortError } from '@domain/shared/cooperative-abort.js';
import { containsHangul } from '@shared/utils/hangul.js';

import type { DeterministicRouter } from './deterministic-router.js';
import type {
  ComparisonUseCaseInput,
  ExecutionPlan,
  FoodPairingUseCaseInput,
  SearchUseCaseInput,
} from './execution-plan-schemas.js';
import type {
  ExecutionRunner,
  ExecutionOutcome,
} from './execution-runner.js';
import {
  MINI_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
  type MiniLoopToolPorts,
} from './mini-loop-schemas.js';
import type { MiniLoopRunner } from './mini-loop.js';
import type { QueryAnalyzerService, AnalysisOutcome } from './query-analyzer.js';
import {
  SynthesisAbortedError,
  addTokenUsage,
  makeZeroTokenUsage,
  type AnswerResult,
} from './synthesis-schemas.js';
import type { SynthesisRunner } from './synthesis-runner.js';
import type { QueryIntent, WineSearchAnalysis } from './wine-search-schemas.js';
import {
  ORCHESTRATOR_ABORTED_ANSWER_ENGLISH,
  ORCHESTRATOR_ABORTED_ANSWER_KOREAN,
  ORCHESTRATOR_DEFAULT_MAX_TOTAL_TOKENS,
  ORCHESTRATOR_MAX_QUERY_CHARS,
  ORCHESTRATOR_STEP_SUMMARY_MAX_CHARS,
  ORCHESTRATOR_TOOL_INPUT_MAX_CHARS,
  TERMINATION_KIND_SECURITY_BLOCK,
  TERMINATION_KIND_UNSUPPORTED_INTENT,
  assertWineSearchResult,
  type ExecutionStep,
  type TerminationKind,
  type WineSearchResult,
} from './wine-search-result-schemas.js';

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Maximum number of characters of query text that may appear in info-level
 *  logs. Defense against accidental PII / prompt-injection capture in log
 *  aggregation (CLAUDE.md schema-quality bar — never log raw query content
 *  above 200 chars). */
const ORCHESTRATOR_LOG_QUERY_SLICE_CHARS = 200;

/** Sentinel terminationReason — the orchestrator begins every run with this
 *  value, then transitions monotonically through
 *  {@link transitionTerminationReason}. `max_steps` is the documented sentinel
 *  per the termination-state-machine module (lowest priority — any explicit
 *  write dominates). */
const ORCHESTRATOR_INITIAL_TERMINATION_REASON: AgentTerminationReason = 'max_steps';

/** Default per-step timeout when callers do not override. Mirrors
 *  `DEFAULT_AGENT_CONFIG.perStepTimeoutMs` (10_000ms). */
const ORCHESTRATOR_DEFAULT_PER_STEP_TIMEOUT_MS = DEFAULT_AGENT_CONFIG.perStepTimeoutMs;

/** Default agent timeout when callers do not override. Mirrors
 *  `DEFAULT_AGENT_CONFIG.agentTimeoutMs` (25_000ms). */
const ORCHESTRATOR_DEFAULT_AGENT_TIMEOUT_MS = DEFAULT_AGENT_CONFIG.agentTimeoutMs;

/** Default `maxSteps` when callers do not override. Mirrors
 *  `DEFAULT_AGENT_CONFIG.maxSteps` (5). */
const ORCHESTRATOR_DEFAULT_MAX_STEPS = DEFAULT_AGENT_CONFIG.maxSteps;

/** Maximum number of synthesis output tokens. Sized so a multi-paragraph
 *  Korean wine recommendation fits comfortably without bursting downstream
 *  budgets. Matches the agent contract executor default. */
const ORCHESTRATOR_DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS = 1_024;

/** Per-tool cap forwarded into the mini-loop when callers do not provide
 *  their own bundle. Mirrors `MINI_LOOP_DEFAULT_PER_TOOL_CAP` (2). The mini
 *  loop will adjust internally if the adaptive budget recommends a different
 *  value. */
const ORCHESTRATOR_DEFAULT_PER_TOOL_CAP = 2;

/** Max characters of an error message we surface in a step `summary`. Long
 *  enough to identify a typical use-case error class without bloating the
 *  trace. Kept above the typical Vespa error message length (≈80 chars). */
const ORCHESTRATOR_ERROR_SUMMARY_MAX_CHARS = 120;

/**
 * Zero-width characters that the JavaScript `String.prototype.trim()` does
 * NOT strip (they are not in the Unicode WhiteSpace property): ZWSP
 * (U+200B), ZWNJ (U+200C), ZWJ (U+200D), and BOM/ZWNBSP (U+FEFF). The
 * admit gate strips these in addition to whitespace so a query containing
 * only invisible separators is rejected as empty (not silently admitted
 * into the analyzer where it surfaces as Layer-4 fallback).
 *
 * The character class uses explicit `\u…` escapes (not literal invisible
 * glyphs) so the source remains greppable and lint rules
 * (`no-irregular-whitespace`, `no-misleading-character-class`) pass.
 *
 * CLAUDE.md rule 8 — character class with `/u` flag, not `\b`.
 * CLAUDE.md rule 16 — module-scope const, not inline regex inside a method.
 */
const ORCHESTRATOR_ADMIT_GATE_ZERO_WIDTH_RE = /(?:\u200B|\u200C|\u200D|\uFEFF)/gu;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Clock seam — orchestrator uses `clock.now()` for `totalDurationMs` so
 * tests can pin determinism via a fake clock.
 */
interface OrchestratorClock {
  readonly now: () => number;
}

/**
 * Logger seam — accepts the small subset of `bootstrapLogger` the
 * orchestrator uses. Tests inject a vi.fn-backed stub.
 */
interface OrchestratorLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
  error(payload: Record<string, unknown>, msg: string): void;
}

/**
 * Optional tool bundle required to drive the mini-loop. When omitted, the
 * orchestrator handles a `multi-step` plan by short-circuiting to the
 * synthesizer (Layer 4 — degraded path). Track C wires this bundle from the
 * container; until then, multi-step queries are best-effort.
 */
export interface OrchestratorMiniLoopToolBundle {
  readonly tools: readonly ToolDefinition[];
  readonly toolPorts: MiniLoopToolPorts;
}

interface WineSearchOrchestratorDeps {
  readonly queryAnalyzer: QueryAnalyzerService;
  readonly router: DeterministicRouter;
  readonly executionRunner: ExecutionRunner;
  readonly miniLoopRunner: MiniLoopRunner;
  readonly synthesisRunner: SynthesisRunner;
  readonly logger?: OrchestratorLogger | undefined;
  readonly clock?: OrchestratorClock | undefined;
  readonly defaultConfig?: Partial<AgentConfig> | undefined;
  readonly miniLoopToolBundle?: OrchestratorMiniLoopToolBundle | undefined;
}

export interface WineSearchInput {
  readonly query: string;
  readonly requestId: string;
  readonly maxSteps?: number;
  readonly perStepTimeoutMs?: number;
  readonly agentTimeoutMs?: number;
  readonly maxTotalTokens?: number;
  readonly abortSignal?: AbortSignal;
}

export {
  
  type WineSearchResult,
} from './wine-search-result-schemas.js';

/**
 * Token-usage shape surfaced into {@link WineSearchResult.tokenUsage}.
 * Re-exported here so HTTP-layer consumers can reach the type without
 * importing from `@domain/ai/port/structured-llm.port.js`. Identical to
 * the canonical {@link TokenUsage} alias, with `readonly` semantics.
 */
export interface TokenUsageShape {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
}

/**
 * Structural interface mirroring the public surface of the
 * {@link WineSearchOrchestrator} class. HTTP-route deps and other
 * composition-root consumers depend on this structural shape so an
 * orchestrator can be swapped (e.g. by a test double) without subclassing.
 *
 * The concrete class implements this interface by construction — the
 * class-level `execute()` is the only public method.
 */
export interface WineSearchOrchestratorContract {
  execute(input: WineSearchInput): Promise<WineSearchResult>;
}

// ---------------------------------------------------------------------------
// Internal mutable state — closed over by `execute()`, never exposed.
// ---------------------------------------------------------------------------

interface OrchestratorState {
  readonly steps: ExecutionStep[];
  tokenUsage: TokenUsage;
  terminationReason: AgentTerminationReason;
  toolOutcomes: ToolOutcome[];
}

/**
 * Dispatch outcome — every plan-branch returns the same shape so the
 * orchestrator's caller (`execute`) can uniformly read the terminal
 * `terminationReason`, `policyBlocked`, and the S1 `terminationKind`
 * discriminant (security vs unsupported, when applicable).
 *
 * `terminationKind` is OPTIONAL and present only on `terminationReason ===
 * 'blocked'` branches — see `wine-search-result-schemas.ts` for the full
 * design note.
 */
type DispatchOutcome =
  | {
      readonly kind: 'ok';
      readonly terminationReason: AgentTerminationReason;
      readonly policyBlocked: boolean;
      readonly terminationKind?: TerminationKind | undefined;
    }
  | { readonly kind: 'aborted' };

function makeInitialState(): OrchestratorState {
  return {
    steps: [],
    tokenUsage: makeZeroTokenUsage(),
    terminationReason: ORCHESTRATOR_INITIAL_TERMINATION_REASON,
    toolOutcomes: [],
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class WineSearchOrchestrator {
  private readonly deps: WineSearchOrchestratorDeps;
  private readonly logger: OrchestratorLogger;
  private readonly clock: OrchestratorClock;

  constructor(deps: WineSearchOrchestratorDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? bootstrapLogger;
    this.clock = deps.clock ?? { now: () => Date.now() };
  }

  /**
   * Execute the full Plan-then-Execute pipeline for a single user query.
   * Returns a {@link WineSearchResult} — invariant `answer.length > 0`
   * because the synthesizer's fallback ladder always produces a non-empty
   * answer. The result is validated against
   * {@link WineSearchResultSchema} before return.
   *
   * Errors:
   *  - The caller's `abortSignal` is propagated cooperatively. If it fires
   *    during analysis or execution, the orchestrator returns a Layer-4
   *    result with `terminationReason='aborted'` (NOT a throw — the HTTP
   *    layer treats this as a 200 with an aborted envelope so the client
   *    can render a friendly cancellation message).
   *  - Unknown internal errors propagate to the synthesizer's layer ladder,
   *    which always produces a valid result. The orchestrator never
   *    fabricates a 200-OK shape from an exception (schema-quality bar).
   */
  async execute(rawInput: WineSearchInput): Promise<WineSearchResult> {
    // Clone — defensive against caller mutating the input concurrently.
    const input = freezeInput(rawInput);
    const startMs = this.clock.now();
    const state = makeInitialState();

    const baseConfig = this.resolveAgentConfig(input);
    const queryHasHangul = containsHangul(input.query);
    const logCtx = {
      requestId: input.requestId,
      queryPreview: input.query.slice(0, ORCHESTRATOR_LOG_QUERY_SLICE_CHARS),
    };

    // ── Phase 0: admit gate. Port semantics from `admitAgentRequest`.
    const admitGate = this.runAdmitGate(input);
    if (admitGate !== undefined) {
      this.logger.info(
        { ...logCtx, phase: 'admit', reason: admitGate.reason, durationMs: 0 },
        '[wine-search-orchestrator] admit gate rejected',
      );
      return this.finishWithoutAnalysis(
        admitGate,
        startMs,
        state,
        queryHasHangul,
        input,
      );
    }

    // ── Pre-flight abort check before any async work.
    if (isSignalAborted(input.abortSignal)) {
      state.terminationReason = transitionTerminationReason(
        state.terminationReason,
        'aborted',
      );
      return this.finalizeAborted(state, startMs, queryHasHangul);
    }

    // ── Phase 1: analyzer.
    const analyzerPhaseStart = this.clock.now();
    let analysisOutcome: AnalysisOutcome;
    try {
      analysisOutcome = await this.deps.queryAnalyzer.analyze({
        query: input.query,
        requestId: input.requestId,
        perStepTimeoutMs: baseConfig.perStepTimeoutMs,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
    } catch (err) {
      // Abort propagates as a controlled exit — anything else falls through
      // to the synthesizer with an empty outcome set (Layer 4).
      if (isAbortError(err) || isSignalAborted(input.abortSignal)) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
        return this.finalizeAborted(state, startMs, queryHasHangul);
      }
      this.logger.warn(
        { ...logCtx, phase: 'analyze', err: errorMessage(err) },
        '[wine-search-orchestrator] analyzer threw — falling through to synthesizer',
      );
      analysisOutcome = { kind: 'rejected', reason: 'malformed' };
    }

    const analyzerDurationMs = Math.max(0, this.clock.now() - analyzerPhaseStart);

    if (analysisOutcome.kind === 'rejected') {
      const summary = `intent=rejected, reason=${analysisOutcome.reason}`;
      this.appendStep(state, {
        source: 'analyzer',
        summary,
        durationMs: analyzerDurationMs,
      });
      this.logger.info(
        { ...logCtx, phase: 'analyze', reason: analysisOutcome.reason, durationMs: analyzerDurationMs },
        '[wine-search-orchestrator] analyzer rejected',
      );
      return this.finishRejectedAnalysis(
        analysisOutcome.reason,
        state,
        startMs,
        queryHasHangul,
        input,
        baseConfig,
      );
    }

    const analysis = analysisOutcome.analysis;
    this.appendStep(state, {
      source: 'analyzer',
      summary: `intent=${analysis.intent}, multi_step=${String(analysis.expectedMultiStep)}`,
      durationMs: analyzerDurationMs,
    });
    this.logger.info(
      { ...logCtx, phase: 'analyze', intent: analysis.intent, durationMs: analyzerDurationMs },
      '[wine-search-orchestrator] analyzer ok',
    );

    if (isSignalAborted(input.abortSignal)) {
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
      return this.finalizeAborted(state, startMs, queryHasHangul);
    }

    // ── Phase 2: router (sync, deterministic).
    const routerPhaseStart = this.clock.now();
    const plan = this.deps.router.route(analysis);
    const routerDurationMs = Math.max(0, this.clock.now() - routerPhaseStart);
    this.appendStep(state, {
      source: 'router',
      summary: `plan=${plan.kind}`,
      durationMs: routerDurationMs,
    });
    this.logger.info(
      { ...logCtx, phase: 'route', planKind: plan.kind, durationMs: routerDurationMs },
      '[wine-search-orchestrator] router ok',
    );

    if (isSignalAborted(input.abortSignal)) {
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
      return this.finalizeAborted(state, startMs, queryHasHangul);
    }

    // ── Phase 3: dispatch on plan kind.
    const dispatchResult = await this.dispatchPlan(plan, analysis, input, state, baseConfig);
    if (dispatchResult.kind === 'aborted') {
      return this.finalizeAborted(state, startMs, queryHasHangul);
    }

    // ── Phase 4: synthesizer (always runs).
    const synthesisPhaseStart = this.clock.now();
    // For dispatch-level blocks (router-reject, runner-rejected) we need to
    // route the synthesizer to the correct Korean/English template. When
    // `terminationKind` is present we set `policyBlocked: true` on the
    // synthesizer call (its short-circuit branch) and pass `blockedKind`
    // for template selection. When absent, the synthesizer runs the LLM
    // path as before.
    const dispatchKind = dispatchResult.terminationKind;
    let answer: AnswerResult;
    try {
      answer = await this.deps.synthesisRunner.run({
        query: input.query,
        requestId: input.requestId,
        analysis,
        toolOutcomes: state.toolOutcomes,
        policyBlocked: dispatchKind !== undefined || dispatchResult.policyBlocked,
        ...(dispatchKind !== undefined ? { blockedKind: dispatchKind } : {}),
        perStepTimeoutMs: baseConfig.perStepTimeoutMs,
        maxOutputTokens: ORCHESTRATOR_DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
    } catch (err) {
      if (err instanceof SynthesisAbortedError || isAbortError(err) || isSignalAborted(input.abortSignal)) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
        return this.finalizeAborted(state, startMs, queryHasHangul);
      }
      // Unknown synthesizer error — surface as Layer-4 abort-free fallback
      // with terminationReason='error'. We do NOT silently fabricate a 200
      // (schema-quality bar).
      this.logger.error(
        { ...logCtx, phase: 'synthesize', err: errorMessage(err) },
        '[wine-search-orchestrator] synthesizer threw — emitting Layer 4 fallback',
      );
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
      return this.finalizeWithSyntheticLayer4(
        state,
        startMs,
        queryHasHangul,
        analysis.intent,
        plan.kind,
        'no_results',
        dispatchKind,
      );
    }
    const synthesisDurationMs = Math.max(0, this.clock.now() - synthesisPhaseStart);

    state.tokenUsage = addTokenUsage(state.tokenUsage, answer.tokenUsage);
    this.appendStep(state, {
      source: 'synthesizer',
      summary: `layer=${answer.layer}, attempts=${String(answer.synthesisAttempts)}`,
      durationMs: synthesisDurationMs,
      tokenUsage: answer.tokenUsage,
    });
    this.logger.info(
      {
        ...logCtx,
        phase: 'synthesize',
        layer: answer.layer,
        attempts: answer.synthesisAttempts,
        durationMs: synthesisDurationMs,
        terminationReason: state.terminationReason,
      },
      '[wine-search-orchestrator] synthesizer ok',
    );

    // Promote the dispatch path's terminal reason now that the synthesizer
    // has run. The state machine ensures hard failures dominate, so a
    // 'fallback' or 'answer' coming from dispatch cannot overwrite an
    // 'aborted' / 'error' state recorded earlier.
    state.terminationReason = transitionTerminationReason(
      state.terminationReason,
      dispatchResult.terminationReason,
    );

    return this.finalize({
      answer,
      state,
      startMs,
      intent: analysis.intent,
      planKind: plan.kind,
      policyBlocked: dispatchResult.policyBlocked,
      ...(dispatchKind !== undefined ? { terminationKind: dispatchKind } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Plan dispatch
  // -------------------------------------------------------------------------

  private async dispatchPlan(
    plan: ExecutionPlan,
    analysis: WineSearchAnalysis,
    input: WineSearchInput,
    state: OrchestratorState,
    baseConfig: AgentConfig,
  ): Promise<DispatchOutcome> {
    if (plan.kind === 'reject') {
      // Router-level reject = `unsupported_intent` (no anchors, no
      // constraints, intent=unknown). It is NOT a security event, so
      // `policyBlocked` is false. See S1 split in
      // `wine-search-result-schemas.ts`.
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'blocked');
      this.appendStep(state, {
        source: 'runner',
        summary: `rejected: ${plan.reason}`,
        durationMs: 0,
      });
      this.logger.info(
        {
          requestId: input.requestId,
          phase: 'router_reject',
          reason: plan.reason,
          terminationKind: TERMINATION_KIND_UNSUPPORTED_INTENT,
          anchors: analysis.anchors.length,
          constraints: analysis.normalizedConstraints.length,
        },
        '[wine-search-orchestrator] router rejected → unsupported_intent',
      );
      return {
        kind: 'ok',
        terminationReason: 'blocked',
        policyBlocked: false,
        terminationKind: TERMINATION_KIND_UNSUPPORTED_INTENT,
      };
    }

    if (plan.kind === 'multi-step') {
      return this.dispatchMultiStep(plan, analysis, input, state, baseConfig);
    }

    return this.dispatchRunner(plan, input, state, baseConfig);
  }

  private async dispatchRunner(
    plan: ExecutionPlan,
    input: WineSearchInput,
    state: OrchestratorState,
    baseConfig: AgentConfig,
  ): Promise<DispatchOutcome> {
    const runnerPhaseStart = this.clock.now();
    let outcome: ExecutionOutcome;
    try {
      outcome = await this.deps.executionRunner.run(plan, {
        requestId: input.requestId,
        perStepTimeoutMs: baseConfig.perStepTimeoutMs,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
    } catch (err) {
      if (isAbortError(err) || isSignalAborted(input.abortSignal)) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
        return { kind: 'aborted' };
      }
      this.appendStep(state, {
        source: 'runner',
        summary: `runner threw: ${errorMessage(err).slice(0, ORCHESTRATOR_ERROR_SUMMARY_MAX_CHARS)}`,
        durationMs: Math.max(0, this.clock.now() - runnerPhaseStart),
      });
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
      return { kind: 'ok', terminationReason: 'error', policyBlocked: false };
    }

    const durationMs = Math.max(0, this.clock.now() - runnerPhaseStart);
    return this.handleExecutionOutcome(outcome, plan, durationMs, state);
  }

  private handleExecutionOutcome(
    outcome: ExecutionOutcome,
    plan: ExecutionPlan,
    durationMs: number,
    state: OrchestratorState,
  ): DispatchOutcome {
    switch (outcome.kind) {
      case 'search-result':
      case 'comparison-result':
      case 'food-pairing-result':
      case 'parallel-results':
      case 'search-then-drinkability': {
        const { toolCalls, observations } = describeExecutionOutcome(outcome, plan);
        // Project the executor outcome into typed ToolOutcome records so the
        // synthesizer can ground on them. Without this projection
        // `synthesisRunner.run` sees an empty outcome set and routes to
        // Layer 4 — exactly the bug surfaced by orchestrator integration
        // tests.
        const projected = projectExecutionOutcomeAsToolOutcomes(outcome, this.clock);
        for (const o of projected) state.toolOutcomes.push(o);
        this.appendStep(state, {
          source: 'runner',
          summary: `outcome=${outcome.kind}`,
          toolCalls,
          observations,
          durationMs,
        });
        return { kind: 'ok', terminationReason: 'answer', policyBlocked: false };
      }
      case 'rejected': {
        // Runner-level rejection (e.g. use-case refused the input). This is
        // a planner / vocabulary signal, NOT a security event — emit
        // `unsupported_intent`, NOT `policy_blocked=true`. See S1 split.
        this.appendStep(state, {
          source: 'runner',
          summary: `rejected: ${outcome.reason}`,
          durationMs,
        });
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'blocked');
        return {
          kind: 'ok',
          terminationReason: 'blocked',
          policyBlocked: false,
          terminationKind: TERMINATION_KIND_UNSUPPORTED_INTENT,
        };
      }
      case 'error': {
        this.appendStep(state, {
          source: 'runner',
          summary: `error: ${outcome.cause.message.slice(0, ORCHESTRATOR_ERROR_SUMMARY_MAX_CHARS)}`,
          durationMs,
        });
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
        return { kind: 'ok', terminationReason: 'error', policyBlocked: false };
      }
      case 'multi-step-required': {
        this.appendStep(state, {
          source: 'runner',
          summary: 'handoff: multi-step-required',
          durationMs,
        });
        // We synthesize a synthetic multi-step plan from the runner's
        // handoff so the same code path handles it as a router-issued
        // multi-step.
        const syntheticPlan: ExecutionPlan = {
          kind: 'multi-step',
          handoff: outcome.handoff,
        };
        // Re-enter with no execution outcomes preserved (the original plan
        // produced none). Use a fresh dispatch — we already counted its
        // runner phase as the step above.
        return this.dispatchMultiStepFromHandoff(syntheticPlan, state);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Multi-step (MiniLoop) branch
  // -------------------------------------------------------------------------

  private async dispatchMultiStep(
    plan: Extract<ExecutionPlan, { kind: 'multi-step' }>,
    analysis: WineSearchAnalysis,
    input: WineSearchInput,
    state: OrchestratorState,
    baseConfig: AgentConfig,
  ): Promise<DispatchOutcome> {
    const bundle = this.deps.miniLoopToolBundle;
    if (bundle === undefined) {
      this.logger.warn(
        { requestId: input.requestId, planKind: plan.kind },
        '[wine-search-orchestrator] multi-step plan requested but miniLoopToolBundle not wired — emitting degraded result',
      );
      this.appendStep(state, {
        source: 'mini_loop',
        summary: 'skipped: tool bundle not wired',
        durationMs: 0,
      });
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'fallback');
      return { kind: 'ok', terminationReason: 'fallback', policyBlocked: false };
    }

    const miniLoopStart = this.clock.now();
    try {
      const outcome = await this.deps.miniLoopRunner.run({
        query: input.query,
        analysis,
        requestId: input.requestId,
        tools: bundle.tools,
        toolPorts: bundle.toolPorts,
        perStepTimeoutMs: baseConfig.perStepTimeoutMs,
        agentTimeoutMs: baseConfig.agentTimeoutMs,
        maxSteps: baseConfig.maxSteps,
        maxTotalTokens: baseConfig.maxTotalTokens,
        maxOutputTokens: MINI_LOOP_DEFAULT_MAX_OUTPUT_TOKENS,
        perToolCap: analysis.recommendedBudget.perToolCap > 0
          ? analysis.recommendedBudget.perToolCap
          : ORCHESTRATOR_DEFAULT_PER_TOOL_CAP,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });

      state.tokenUsage = addTokenUsage(state.tokenUsage, outcome.tokenUsage);
      for (const o of outcome.toolOutcomes) state.toolOutcomes.push(o);

      // Emit one ExecutionStep per mini-loop step so the trace is dense.
      const miniLoopBaseDuration = Math.max(0, this.clock.now() - miniLoopStart);
      let recordedDuration = 0;
      for (const step of outcome.steps) {
        recordedDuration += Math.max(0, step.durationMs);
        const toolCalls = step.toolCalls.length > 0
          ? step.toolCalls.map((c) => ({
            name: clipString(c.tool, ORCHESTRATOR_TOOL_INPUT_MAX_CHARS),
            arguments: clipToolCallInput(c.input),
          }))
          : undefined;
        const observations = step.observations.length > 0
          ? step.observations.map((o) => clipString(o, ORCHESTRATOR_TOOL_INPUT_MAX_CHARS))
          : undefined;
        this.appendStep(state, {
          source: 'mini_loop',
          summary: clipString(
            `step=${String(step.index)} kind=${step.kind}${step.errorReason !== undefined ? ` reason=${step.errorReason}` : ''}`,
            ORCHESTRATOR_STEP_SUMMARY_MAX_CHARS,
          ),
          ...(toolCalls !== undefined ? { toolCalls } : {}),
          ...(observations !== undefined ? { observations } : {}),
          durationMs: Math.max(0, step.durationMs),
          tokenUsage: step.tokenUsage,
        });
      }
      // If no per-step durations were recorded, surface the wall-clock as a
      // single synthetic step so the trace is not empty.
      if (outcome.steps.length === 0) {
        this.appendStep(state, {
          source: 'mini_loop',
          summary: `terminated: ${outcome.terminationReason}`,
          durationMs: miniLoopBaseDuration,
        });
      }
      void recordedDuration;

      state.terminationReason = transitionTerminationReason(
        state.terminationReason,
        outcome.terminationReason,
      );
      return { kind: 'ok', terminationReason: outcome.terminationReason, policyBlocked: false };
    } catch (err) {
      if (isAbortError(err) || isSignalAborted(input.abortSignal)) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
        return { kind: 'aborted' };
      }
      this.appendStep(state, {
        source: 'mini_loop',
        summary: `mini-loop threw: ${errorMessage(err).slice(0, ORCHESTRATOR_ERROR_SUMMARY_MAX_CHARS)}`,
        durationMs: Math.max(0, this.clock.now() - miniLoopStart),
      });
      state.terminationReason = transitionTerminationReason(state.terminationReason, 'error');
      return { kind: 'ok', terminationReason: 'error', policyBlocked: false };
    }
  }

  private dispatchMultiStepFromHandoff(
    syntheticPlan: Extract<ExecutionPlan, { kind: 'multi-step' }>,
    state: OrchestratorState,
  ): DispatchOutcome {
    // The runner can only emit `multi-step-required` when the underlying use
    // case explicitly hands off. We don't have analysis here; we surface a
    // fallback step and let the synthesizer handle the rest.
    this.appendStep(state, {
      source: 'mini_loop',
      summary: `handoff: ${syntheticPlan.handoff.initialAction}`,
      durationMs: 0,
    });
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'fallback');
    return { kind: 'ok', terminationReason: 'fallback', policyBlocked: false };
  }

  // -------------------------------------------------------------------------
  // Admit gate (port of `admitAgentRequest`) — no QuerySanitizer here; the
  // analyzer's classifyQueryBudget already runs an adversarial sanitizer.
  // -------------------------------------------------------------------------

  private runAdmitGate(input: WineSearchInput): { readonly reason: 'empty_query' | 'too_long' } | undefined {
    // Strip zero-width characters BEFORE trim — `String.prototype.trim()`
    // removes Unicode WhiteSpace property runs, which excludes ZWSP
    // (U+200B), ZWNJ (U+200C), ZWJ (U+200D), and BOM (U+FEFF). Without
    // this strip, a query of three U+200B ZWSPs survives trim and reaches
    // the analyzer as a non-empty string.
    const stripped = input.query.replace(ORCHESTRATOR_ADMIT_GATE_ZERO_WIDTH_RE, '');
    const trimmed = stripped.trim();
    if (trimmed.length === 0) return { reason: 'empty_query' };
    if (input.query.length > ORCHESTRATOR_MAX_QUERY_CHARS) return { reason: 'too_long' };
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Finalize helpers
  // -------------------------------------------------------------------------

  private async finishWithoutAnalysis(
    admit: { readonly reason: 'empty_query' | 'too_long' },
    startMs: number,
    state: OrchestratorState,
    queryHasHangul: boolean,
    input: WineSearchInput,
  ): Promise<WineSearchResult> {
    this.appendStep(state, {
      source: 'analyzer',
      summary: `rejected_at_gate: ${admit.reason}`,
      durationMs: 0,
    });
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'blocked');

    // Admit-gate rejections (empty / too long) are NOT security events —
    // they are malformed-input signals. S1 split: emit
    // `unsupported_intent`, NOT `policy_blocked=true`. The synthesizer
    // surfaces the coverage-gap Korean / English template.
    const blockedKind: TerminationKind = TERMINATION_KIND_UNSUPPORTED_INTENT;

    // Run synthesizer on the policy-blocked branch so the user gets a
    // consistent, deterministic Korean/English template (no fabrication).
    const synthesisStart = this.clock.now();
    let answer: AnswerResult;
    try {
      // Build a minimal analysis shell so the synthesizer can route Korean
      // vs English text. The synthesizer's `policyBlocked` short-circuit
      // does not actually inspect the analysis content.
      const shellAnalysis = makeBlockedAnalysisShell(input.query, queryHasHangul);
      answer = await this.deps.synthesisRunner.run({
        query: input.query,
        requestId: input.requestId,
        analysis: shellAnalysis,
        toolOutcomes: [],
        policyBlocked: true,
        blockedKind,
        perStepTimeoutMs: this.resolvePerStepTimeoutMs(input),
        maxOutputTokens: ORCHESTRATOR_DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
    } catch (err) {
      if (err instanceof SynthesisAbortedError || isAbortError(err) || isSignalAborted(input.abortSignal)) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
        return this.finalizeAborted(state, startMs, queryHasHangul);
      }
      return this.finalizeWithSyntheticLayer4(
        state,
        startMs,
        queryHasHangul,
        'unknown',
        'reject',
        'policy_blocked',
        blockedKind,
      );
    }
    const synthesisDurationMs = Math.max(0, this.clock.now() - synthesisStart);
    state.tokenUsage = addTokenUsage(state.tokenUsage, answer.tokenUsage);
    this.appendStep(state, {
      source: 'synthesizer',
      summary: `layer=${answer.layer}, attempts=${String(answer.synthesisAttempts)}`,
      durationMs: synthesisDurationMs,
      tokenUsage: answer.tokenUsage,
    });
    this.logger.info(
      {
        requestId: input.requestId,
        phase: 'admit_gate_blocked',
        reason: admit.reason,
        terminationKind: blockedKind,
        anchors: 0,
        constraints: 0,
      },
      '[wine-search-orchestrator] admit-gate blocked → unsupported_intent',
    );

    return this.finalize({
      answer,
      state,
      startMs,
      intent: 'rejected',
      planKind: 'reject',
      policyBlocked: false,
      terminationKind: blockedKind,
    });
  }

  private async finishRejectedAnalysis(
    reason: 'empty_query' | 'too_long' | 'malformed' | 'blocked' | 'off_domain',
    state: OrchestratorState,
    startMs: number,
    queryHasHangul: boolean,
    input: WineSearchInput,
    baseConfig: AgentConfig,
  ): Promise<WineSearchResult> {
    // S1 semantic split: `reason === 'blocked'` is the ONLY case set by the
    // analyzer's adversarial sanitizer (`classifyQueryBudget === 'adversarial'`).
    // Every other analyzer-rejection reason (`empty_query`, `too_long`,
    // `malformed`, `off_domain`) is a coverage/shape signal — emit
    // `unsupported_intent`, NOT `policy_blocked=true`.
    const isSecurityBlock = reason === 'blocked';
    const blockedKind: TerminationKind = isSecurityBlock
      ? TERMINATION_KIND_SECURITY_BLOCK
      : TERMINATION_KIND_UNSUPPORTED_INTENT;
    const policyBlocked = isSecurityBlock;
    // Termination semantics:
    //   - SECURITY block → 'blocked' (the run was hard-failed by the policy
    //     gate; downstream metrics should not credit it as a successful
    //     answer).
    //   - Non-security reject (off_domain / knowledge_only / empty_query
    //     / too_long / malformed) → 'answer' — the agent DID respond with
    //     a deterministic template (the unsupported_intent copy is a
    //     legitimate answer, not a refusal). Bench scenarios like #20 /
    //     #103 / #104 explicitly assert `terminationReason: 'answer'` for
    //     these off-domain redirects; pre-fix they collapsed to 'blocked'
    //     and lost the termination dimension.
    state.terminationReason = transitionTerminationReason(
      state.terminationReason,
      isSecurityBlock ? 'blocked' : 'answer',
    );

    const synthesisStart = this.clock.now();
    let answer: AnswerResult;
    try {
      const shellAnalysis = makeBlockedAnalysisShell(input.query, queryHasHangul);
      answer = await this.deps.synthesisRunner.run({
        query: input.query,
        requestId: input.requestId,
        analysis: shellAnalysis,
        toolOutcomes: [],
        // The synthesizer's short-circuit fires on `policyBlocked === true`.
        // For unsupported-intent (no security event), we still want the
        // deterministic template — set `policyBlocked = true` and route via
        // `blockedKind` to the unsupported-intent Korean / English template.
        policyBlocked: true,
        blockedKind,
        perStepTimeoutMs: baseConfig.perStepTimeoutMs,
        maxOutputTokens: ORCHESTRATOR_DEFAULT_SYNTHESIS_MAX_OUTPUT_TOKENS,
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
    } catch (err) {
      if (err instanceof SynthesisAbortedError || isAbortError(err) || isSignalAborted(input.abortSignal)) {
        state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
        return this.finalizeAborted(state, startMs, queryHasHangul);
      }
      return this.finalizeWithSyntheticLayer4(
        state,
        startMs,
        queryHasHangul,
        'rejected',
        'reject',
        'policy_blocked',
        blockedKind,
      );
    }
    const synthesisDurationMs = Math.max(0, this.clock.now() - synthesisStart);
    state.tokenUsage = addTokenUsage(state.tokenUsage, answer.tokenUsage);
    this.appendStep(state, {
      source: 'synthesizer',
      summary: `layer=${answer.layer}, attempts=${String(answer.synthesisAttempts)}`,
      durationMs: synthesisDurationMs,
      tokenUsage: answer.tokenUsage,
    });
    if (!isSecurityBlock) {
      this.logger.info(
        {
          requestId: input.requestId,
          phase: 'analyzer_rejected_unsupported',
          reason,
          terminationKind: blockedKind,
          anchors: 0,
          constraints: 0,
        },
        '[wine-search-orchestrator] analyzer rejected → unsupported_intent',
      );
    }

    return this.finalize({
      answer,
      state,
      startMs,
      intent: 'rejected',
      planKind: 'reject',
      policyBlocked,
      terminationKind: blockedKind,
    });
  }

  private finalizeAborted(
    state: OrchestratorState,
    startMs: number,
    queryHasHangul: boolean,
  ): WineSearchResult {
    state.terminationReason = transitionTerminationReason(state.terminationReason, 'aborted');
    const answerText = queryHasHangul
      ? ORCHESTRATOR_ABORTED_ANSWER_KOREAN
      : ORCHESTRATOR_ABORTED_ANSWER_ENGLISH;
    const totalDurationMs = Math.max(0, this.clock.now() - startMs);
    return assertWineSearchResult({
      answer: answerText,
      layer: 'layer4',
      groundedOnToolResults: false,
      toolOutcomes: state.toolOutcomes,
      executionSteps: state.steps,
      toolCallCount: computeToolCallCount(state.steps),
      tokenUsage: state.tokenUsage,
      totalDurationMs,
      terminationReason: 'aborted',
      policyBlocked: false,
      intent: 'rejected',
      planKind: 'reject',
    });
  }

  private finalizeWithSyntheticLayer4(
    state: OrchestratorState,
    startMs: number,
    queryHasHangul: boolean,
    intent: QueryIntent | 'rejected',
    planKind: ExecutionPlan['kind'],
    degradedReason: NonNullable<AnswerResult['degradedReason']>,
    terminationKind?: TerminationKind,
  ): WineSearchResult {
    const totalDurationMs = Math.max(0, this.clock.now() - startMs);
    const answerText = queryHasHangul
      ? '요청하신 와인 정보를 현재 처리하지 못했습니다. 검색어를 바꿔서 다시 시도해주세요.'
      : 'We could not process your wine query. Please try rephrasing or simplifying your search.';
    // S1: `policyBlocked` is true ONLY for a real security block. When the
    // caller passes a `terminationKind` we honor it; otherwise we fall back
    // to the legacy "policy_blocked degradedReason → true" heuristic ONLY
    // when the caller has not narrowed the kind (degradedReason alone is
    // ambiguous between security and coverage-gap blocks).
    const policyBlocked = terminationKind === TERMINATION_KIND_SECURITY_BLOCK
      ? true
      : terminationKind === TERMINATION_KIND_UNSUPPORTED_INTENT
        ? false
        : degradedReason === 'policy_blocked';
    return assertWineSearchResult({
      answer: answerText,
      layer: 'layer4',
      groundedOnToolResults: false,
      toolOutcomes: state.toolOutcomes,
      executionSteps: state.steps,
      toolCallCount: computeToolCallCount(state.steps),
      tokenUsage: state.tokenUsage,
      totalDurationMs,
      terminationReason: state.terminationReason,
      policyBlocked,
      ...(terminationKind !== undefined ? { terminationKind } : {}),
      degradedReason,
      intent,
      planKind,
    });
  }

  private finalize(args: {
    readonly answer: AnswerResult;
    readonly state: OrchestratorState;
    readonly startMs: number;
    readonly intent: QueryIntent | 'rejected';
    readonly planKind: ExecutionPlan['kind'];
    readonly policyBlocked: boolean;
    readonly terminationKind?: TerminationKind | undefined;
  }): WineSearchResult {
    const totalDurationMs = Math.max(0, this.clock.now() - args.startMs);
    return assertWineSearchResult({
      answer: args.answer.answer,
      layer: args.answer.layer,
      groundedOnToolResults: args.answer.groundedOnToolResults,
      toolOutcomes: args.state.toolOutcomes,
      executionSteps: args.state.steps,
      toolCallCount: computeToolCallCount(args.state.steps),
      tokenUsage: args.state.tokenUsage,
      totalDurationMs,
      terminationReason: args.state.terminationReason,
      policyBlocked: args.policyBlocked,
      ...(args.terminationKind !== undefined ? { terminationKind: args.terminationKind } : {}),
      ...(args.answer.degradedReason !== undefined ? { degradedReason: args.answer.degradedReason } : {}),
      intent: args.intent,
      planKind: args.planKind,
    });
  }

  // -------------------------------------------------------------------------
  // Step appending — bounded; the schema validates the final array but we
  // truncate the summary defensively up front.
  // -------------------------------------------------------------------------

  private appendStep(state: OrchestratorState, step: Omit<ExecutionStep, 'index'>): void {
    const safeStep: ExecutionStep = {
      ...step,
      summary: clipString(step.summary, ORCHESTRATOR_STEP_SUMMARY_MAX_CHARS),
      index: state.steps.length,
    };
    state.steps.push(safeStep);
  }

  // -------------------------------------------------------------------------
  // Config resolution
  // -------------------------------------------------------------------------

  private resolveAgentConfig(input: WineSearchInput): AgentConfig {
    const defaults = {
      ...DEFAULT_AGENT_CONFIG,
      ...(this.deps.defaultConfig ?? {}),
    };
    return {
      maxSteps: pickFiniteInt(input.maxSteps, defaults.maxSteps, ORCHESTRATOR_DEFAULT_MAX_STEPS),
      agentTimeoutMs: pickFiniteInt(input.agentTimeoutMs, defaults.agentTimeoutMs, ORCHESTRATOR_DEFAULT_AGENT_TIMEOUT_MS),
      perStepTimeoutMs: pickFiniteInt(input.perStepTimeoutMs, defaults.perStepTimeoutMs, ORCHESTRATOR_DEFAULT_PER_STEP_TIMEOUT_MS),
      maxContextChars: defaults.maxContextChars,
      maxTotalTokens: pickFiniteInt(input.maxTotalTokens, defaults.maxTotalTokens, ORCHESTRATOR_DEFAULT_MAX_TOTAL_TOKENS),
    };
  }

  private resolvePerStepTimeoutMs(input: WineSearchInput): number {
    return pickFiniteInt(
      input.perStepTimeoutMs,
      this.deps.defaultConfig?.perStepTimeoutMs ?? DEFAULT_AGENT_CONFIG.perStepTimeoutMs,
      ORCHESTRATOR_DEFAULT_PER_STEP_TIMEOUT_MS,
    );
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function freezeInput(input: WineSearchInput): WineSearchInput {
  // No mutation — produce a shallow clone so the orchestrator does not
  // depend on caller-side mutability of `input`. The original `query` is a
  // string (immutable).
  return { ...input };
}

/** Read the current aborted state without letting TypeScript narrow the
 *  property type across control-flow boundaries (which would otherwise
 *  collapse subsequent checks to `false | undefined`). */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  // Read `aborted` through a local variable so TypeScript does not narrow
  // the property type across the orchestrator's many control-flow
  // boundaries (a direct `signal.aborted === true` triggers member
  // narrowing that collapses subsequent reads to `false | undefined`).
  const aborted: boolean = signal.aborted;
  return aborted;
}

function pickFiniteInt(
  primary: number | undefined,
  fallback: number | undefined,
  ultimate: number,
): number {
  if (primary !== undefined && Number.isFinite(primary) && primary > 0) return Math.floor(primary);
  if (fallback !== undefined && Number.isFinite(fallback) && fallback > 0) return Math.floor(fallback);
  return ultimate;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clipString(value: string, max: number): string {
  if (value.length <= max) return value;
  // Guard against `max < 1` collapsing to a negative slice index (which
  // returns ""); we always preserve at least one character before the
  // ellipsis.
  const head = Math.max(0, max - 1);
  return `${value.slice(0, head)}…`;
}

/**
 * Sum the `toolCalls?.length` across every `ExecutionStep` whose source emits
 * real tool invocations (`runner` and `mini_loop` — the analyzer / router /
 * synthesizer never emit `toolCalls`). Surfaces as `toolCallCount` at the top
 * of {@link WineSearchResult} so the HTTP wire's `execution.tool_call_count`
 * is a pure case-rename at the route boundary — no recomputation downstream.
 *
 * Pure function — no state.
 */
function computeToolCallCount(steps: readonly ExecutionStep[]): number {
  let n = 0;
  for (const step of steps) {
    if (step.source !== 'runner' && step.source !== 'mini_loop') continue;
    if (step.toolCalls === undefined) continue;
    n += step.toolCalls.length;
  }
  return n;
}

function clipToolCallInput(input: Record<string, unknown>): Record<string, unknown> {
  // The schema permits arbitrary `Record<string, unknown>` values; we clip
  // any string field that exceeds the bound so the schema parse passes.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      out[key] = clipString(value, ORCHESTRATOR_TOOL_INPUT_MAX_CHARS);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function makeBlockedAnalysisShell(query: string, queryHasHangul: boolean): WineSearchAnalysis {
  // Minimal shell — the synthesizer's policyBlocked short-circuit does not
  // read these fields. Kept here so we don't surface `undefined` into the
  // analysis-typed runner inputs.
  return {
    intent: 'unknown',
    anchors: [],
    normalizedConstraints: [],
    contract: {
      requiresDrinkabilityCheck: false,
      requiresGroundedWineSearch: false,
      hasEntityMetadataSignal: false,
    },
    expectedMultiStep: false,
    recommendedBudget: { maxSteps: 1, perToolCap: 2 },
    hangulDominant: queryHasHangul,
    preservedSurface: query.slice(0, ORCHESTRATOR_MAX_QUERY_CHARS),
  };
}

interface ExecutionStepShape {
  readonly toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  readonly observations?: string[];
}

/**
 * Convert the ExecutionRunner's typed result envelope into the `ToolOutcome[]`
 * the synthesizer expects. Each branch builds one or more success-tagged
 * outcomes anchored on the underlying response. Drinkability fan-out and
 * parallel-search produce multiple outcomes; everything else yields one.
 */
function projectExecutionOutcomeAsToolOutcomes(
  outcome: Exclude<ExecutionOutcome, { kind: 'rejected' | 'error' | 'multi-step-required' }>,
  clock: OrchestratorClock,
): readonly ToolOutcome[] {
  const now = clock.now();
  switch (outcome.kind) {
    case 'search-result':
      return [makeToolOutcome('search_wines', outcome.result, now)];
    case 'comparison-result':
      return [makeToolOutcome('compare_wines', outcome.result, now)];
    case 'food-pairing-result': {
      const pair = makeToolOutcome('get_food_pairings', outcome.result, now);
      if (outcome.then === undefined) return [pair];
      return [pair, makeToolOutcome('search_wines', outcome.then.result, now)];
    }
    case 'parallel-results':
      return outcome.results.map((r) => makeToolOutcome('search_wines', r, now));
    case 'search-then-drinkability': {
      const outcomes: ToolOutcome[] = [makeToolOutcome('search_wines', outcome.search, now)];
      for (const probe of outcome.drinkability) {
        outcomes.push(makeToolOutcome('check_drinking_window', probe, now));
      }
      return outcomes;
    }
  }
}

function makeToolOutcome(
  tool: string,
  result: unknown,
  ts: number,
): ToolOutcome {
  // Empty `results` arrays still classify as `success` here — the runner
  // already accepted the use case as having succeeded; the synthesizer can
  // route empty result sets through its own degraded-template ladder.
  return {
    stepId: `orch:${tool}:${String(ts)}`,
    tool,
    kind: 'success',
    result,
    durationMs: 0,
  };
}

function describeExecutionOutcome(
  outcome: Exclude<ExecutionOutcome, { kind: 'rejected' | 'error' | 'multi-step-required' }>,
  plan: ExecutionPlan,
): ExecutionStepShape {
  // Surface a structured tool-call summary based on the plan kind so the
  // ExecutionStep[] trace carries the same diagnostic signal the runner
  // already emits internally.
  switch (outcome.kind) {
    case 'search-result':
      return planSearchToolCallSummary(plan);
    case 'parallel-results':
      return planParallelToolCallSummary(plan);
    case 'comparison-result':
      return planComparisonToolCallSummary(plan);
    case 'food-pairing-result':
      return planFoodPairingToolCallSummary(plan);
    case 'search-then-drinkability':
      return planSearchToolCallSummary(plan);
  }
}

function planSearchToolCallSummary(
  plan: ExecutionPlan,
): ExecutionStepShape {
  if (plan.kind === 'single-search' || plan.kind === 'search-then-drinkability') {
    const sample = sampleSearchInput(plan.searchInput);
    return { toolCalls: [{ name: 'search_wines', arguments: sample }] };
  }
  return {};
}

function planParallelToolCallSummary(
  plan: ExecutionPlan,
): ExecutionStepShape {
  if (plan.kind !== 'parallel-search') return {};
  return {
    toolCalls: plan.searches.map((s) => ({
      name: 'search_wines',
      arguments: sampleSearchInput(s),
    })),
  };
}

function planComparisonToolCallSummary(
  plan: ExecutionPlan,
): ExecutionStepShape {
  if (plan.kind !== 'comparison') return {};
  return {
    toolCalls: [{ name: 'compare_wines', arguments: sampleComparisonInput(plan.comparisonInput) }],
  };
}

function planFoodPairingToolCallSummary(
  plan: ExecutionPlan,
): ExecutionStepShape {
  if (plan.kind !== 'food-pairing-then-search') return {};
  return {
    toolCalls: [
      { name: 'get_food_pairings', arguments: sampleFoodPairingInput(plan.pairingInput) },
      { name: 'search_wines', arguments: sampleSearchInput(plan.searchInput) },
    ],
  };
}

function sampleSearchInput(input: SearchUseCaseInput): Record<string, unknown> {
  // Keep the trace lean — only the discriminating fields.
  return {
    query: clipString(input.query, ORCHESTRATOR_TOOL_INPUT_MAX_CHARS),
    ...(input.filters !== undefined ? { filterCount: input.filters.length } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}

function sampleComparisonInput(input: ComparisonUseCaseInput): Record<string, unknown> {
  return {
    originalQuery: clipString(input.originalQuery, ORCHESTRATOR_TOOL_INPUT_MAX_CHARS),
    legs: input.legs.length,
  };
}

function sampleFoodPairingInput(input: FoodPairingUseCaseInput): Record<string, unknown> {
  return {
    food: clipString(input.food, ORCHESTRATOR_TOOL_INPUT_MAX_CHARS),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.maxPriceKrw !== undefined ? { maxPriceKrw: input.maxPriceKrw } : {}),
  };
}

void ORCHESTRATOR_DEFAULT_MAX_TOTAL_TOKENS;
