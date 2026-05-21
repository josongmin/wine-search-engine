/**
 * ShadowModeScorer — composes `ShadowModeRunner` + the orchestrator-agnostic
 * bench scorer (`test/benchmark/agent/scorer.ts`) to emit side-by-side scoring
 * deltas between the legacy ReAct agent and the new `WineSearchOrchestrator`.
 *
 * Why this module exists (cutover validation):
 *   Track D's `ShadowModeRunner` reports a *behavioural* diff (answer
 *   similarity, tool-set overlap, termination parity). The bench scorer
 *   reports a *quality* score across 12+ dimensions (executionEfficiency,
 *   answerQuality, faithfulness, …). Cutover requires both signals: shadow
 *   confirms the new orchestrator behaves comparably; scoring confirms it
 *   scores at least as well on the 18k-line scenario corpus.
 *
 *   This composer wires the two: one `scoreOnce()` call runs both
 *   orchestrators in parallel, projects each result into `ScenarioExecution`
 *   via the pure `bench-scorer-adapter`, invokes the injected scorer on each
 *   side, and returns a `ShadowModeScoringReport` with a per-dimension delta.
 *
 * Invariants (CLAUDE.md SOTA+++++):
 *   - Composer is pure orchestration. The scorer is injected so unit tests
 *     can pin deterministic per-dimension outputs without loading the 3k-line
 *     scorer module.
 *   - Every threshold is a named const (rule 15) with a domain justification.
 *   - Result schema is `.strict()` Zod (rule 10), every numeric `.finite()`.
 *   - Errored side → zero-score sentinel; verdict still computable so the
 *     bench harness can report a regression instead of crashing.
 *   - No `for...of break` for accumulation (rule 17): per-dimension scan loops
 *     visit every dimension to surface every regression.
 */

import { z } from 'zod';
import type { ShadowModeRunner } from './shadow-mode-runner.js';
import type {
  ShadowModeReport,
  ShadowModeOrchestratorOutcome,
} from './shadow-mode-schemas.js';
import {
  ShadowModeReportSchema,
} from './shadow-mode-schemas.js';
import {
  agentResultToScenarioExecution,
  wineSearchResultToScenarioExecution,
  type ScenarioExecutionLike,
  type ScenarioTerminationReason,
} from './bench-scorer-adapter.js';
import type { WineSearchResult } from './wine-search-result-schemas.js';
import type { AgentResult } from '@domain/agent/model/agent-result.js';
import type { LlmJudge } from './llm-judge.js';

// ---------------------------------------------------------------------------
// Structural mirror of the bench scorer's *result* contract
//
// Same reasoning as in `bench-scorer-adapter.ts`: the canonical types live in
// `test/benchmark/agent/scorer.ts` (rootDir-excluded). We mirror the surface
// the composer touches — `scores.overall` and the dimension axes — and let
// callers compose with the full type when wiring at the script layer.
//
// A contract test (`__tests__/bench-scorer-adapter.test.ts`) confirms the
// real `ScenarioResult` assigns to this mirror.
// ---------------------------------------------------------------------------

export interface ScenarioScoresLike {
  readonly executionEfficiency: number;
  readonly answerQuality: number;
  readonly terminationCorrectness: number;
  readonly costEfficiency: number;
  readonly faithfulness: number | null;
  readonly contextRelevance: number | null;
  readonly contextRecall: number | null;
  readonly judge: number | null;
  readonly overall: number;
}

export interface ScenarioResultLike {
  readonly id: number;
  readonly tier: string;
  readonly query: string;
  readonly skipped: boolean;
  readonly error?: string | undefined;
  readonly scores: ScenarioScoresLike;
}

/** Mirror of `AgentBenchmarkScenario` — only the fields the scorer needs at
 *  the composer layer. Real consumers pass the full scenario through. */
export interface AgentBenchmarkScenarioLike {
  readonly id: number;
  readonly tier: string;
  readonly query: string;
}

// ---------------------------------------------------------------------------
// Named constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/**
 * Per-dimension delta below which we treat the new orchestrator as a true
 * regression. 0.05 chosen empirically: scorer dimensions sit on a [0, 1]
 * scale and the corpus-level variance between two repeated legacy runs is
 * typically below 0.02; 0.05 leaves a 2.5x safety margin before alerting.
 */
export const SHADOW_SCORE_REGRESSION_THRESHOLD = 0.05;

/**
 * Absolute |totalDelta| below which the run is considered at parity. Tighter
 * than the per-dimension threshold because `totalDelta` is the weighted
 * geo-mean — small per-dim wobbles average out, so a 0.005 envelope is
 * sufficient to distinguish "indistinguishable" from "directional".
 */
export const SHADOW_SCORE_PARITY_EPSILON = 0.005;

/**
 * Sentinel total score used when one side errored. Anchored at the
 * bench-scorer's ZERO_SCORES.overall so the delta math sees an unambiguous
 * regression / improvement signal rather than NaN.
 */
const SHADOW_SCORE_ERROR_SENTINEL = 0;

/**
 * IEEE-754 wobble tolerance for the regression boundary check. Because
 * `0.7 - 0.05 === 0.6499999999999999` (not 0.65 exactly), a literal "drop
 * of exactly threshold" computed as a subtraction can round just past the
 * threshold and false-positive a regression. 1e-9 is far below any
 * meaningful score variance (scores live on a [0,1] grid with three to four
 * meaningful decimals) and is the standard fp-comparison floor.
 */
const SHADOW_SCORE_FP_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Verdict emitted per scenario.
 *
 *   - `'parity'`     — |totalDelta| < EPSILON and no per-dim regression.
 *   - `'improved'`   — totalDelta > 0 and no per-dim regression past threshold.
 *   - `'regressed'`  — at least one dimension fell below legacy by more than
 *                      `SHADOW_SCORE_REGRESSION_THRESHOLD`, regardless of the
 *                      direction of `totalDelta`.
 *   - `'mixed'`      — some dimensions up, some down, but no single dimension
 *                      crossed the regression threshold; surfaces as
 *                      "interesting but not actionable".
 */
export type ShadowModeScoringVerdict =
  | 'parity'
  | 'improved'
  | 'regressed'
  | 'mixed';

export interface ScoreDelta {
  readonly totalDelta: number;
  readonly perDimension: Readonly<Record<string, number>>;
  readonly regressedDimensions: readonly string[];
}

export interface ShadowModeScoringReport {
  readonly shadowDiff: ShadowModeReport;
  readonly legacyScore: ScenarioResultLike;
  readonly wineSearchScore: ScenarioResultLike;
  readonly scoreDelta: ScoreDelta;
  readonly verdict: ShadowModeScoringVerdict;
}

// ---------------------------------------------------------------------------
// Zod schema (runtime contract guard)
// ---------------------------------------------------------------------------

/**
 * Zod schema for the *delta* portion of the report only. The embedded
 * `ScenarioResult` and `ShadowModeReport` are validated by their owning
 * modules (the bench scorer / shadow-mode runner), so re-validating them
 * here would duplicate work. We validate the *new* surface — the delta and
 * verdict — strictly, so consumers can rely on shape.
 *
 * Numerics use `.finite()` to defend against NaN propagation from a
 * misbehaving scorer (CLAUDE.md schema-quality bar).
 */
export const ScoreDeltaSchema = z.object({
  totalDelta: z.number().finite(),
  perDimension: z.record(z.string(), z.number().finite()),
  regressedDimensions: z.array(z.string().min(1)),
}).strict();

export const ShadowModeScoringVerdictSchema = z.enum([
  'parity',
  'improved',
  'regressed',
  'mixed',
]);

// ---------------------------------------------------------------------------
// Dependencies & inputs
// ---------------------------------------------------------------------------

/**
 * Pluggable scorer signature. Mirrors `scoreScenario` from the bench scorer
 * but typed as a callable so tests can pin deterministic outputs without
 * loading the 3k-line scorer module. Production wiring maps these args onto
 * `scoreScenario(scenario, execution, judgeScore, faithfulnessScore, error,
 * undefined, judgeReasoning)` at the script-level wire-up.
 *
 * `judgeScore` / `faithfulnessScore` are optional: when the composer runs an
 * `LlmJudge` (see {@link ShadowModeScoringDeps.judge}) they carry the judge's
 * clamped [0,1] outputs and the scorer populates the `judge` / `faithfulness`
 * dimensions; when omitted those dims stay `null` (the historic behavior).
 *
 * The scenario / execution / result types are the structural mirrors defined
 * in this module — the real scorer's types are a strict superset, so its
 * `scoreScenario` slot-fills this signature at the script-level wire-up.
 */
export type BenchScorerFn = (
  scenario: AgentBenchmarkScenarioLike,
  execution: ScenarioExecutionLike | null,
  error?: string,
  judgeScore?: number,
  faithfulnessScore?: number,
  judgeReasoning?: string,
) => ScenarioResultLike;

export interface ShadowModeScoringDeps {
  /** The shadow-mode runner. Injected for testability. */
  readonly runner: Pick<ShadowModeRunner, 'runOnce'>;
  /** Pure scorer — same signature on both sides. */
  readonly scorer: BenchScorerFn;
  /**
   * Optional LLM-as-judge. When present, the composer runs it independently
   * on the legacy and wine-search answers (each with its own observations)
   * BEFORE scoring and threads the resulting `score` → scorer `judgeScore`
   * and `faithfulness` → scorer `faithfulnessScore`. When absent (the
   * default), both dims stay `null` — behavior is byte-for-byte unchanged.
   *
   * Per-side judging is independent: a judge failure on one side leaves THAT
   * side's judge / faithfulness dims null (graceful degradation) without
   * affecting the other side.
   */
  readonly judge?: LlmJudge;
}

export interface ShadowModeScoringInput {
  readonly scenario: AgentBenchmarkScenarioLike;
  /** Overrides `scenario.query` when the caller wants to score a probe
   *  variant against the same scenario expectations. Optional. */
  readonly query?: string;
  /** Scenario-specific judge rubric (`scenario.expectation.rubric`). Forwarded
   *  to the `LlmJudge` when one is wired. Ignored when no judge is present. */
  readonly rubric?: string;
  readonly requestId: string;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// ShadowModeScorer
// ---------------------------------------------------------------------------

export class ShadowModeScorer {
  constructor(private readonly deps: ShadowModeScoringDeps) {}

  async scoreOnce(input: ShadowModeScoringInput): Promise<ShadowModeScoringReport> {
    const runOnceArgs: Parameters<ShadowModeRunner['runOnce']>[0] = {
      query: input.query ?? input.scenario.query,
      requestId: input.requestId,
      scenarioId: String(input.scenario.id),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    };
    const shadowDiff = await this.deps.runner.runOnce(runOnceArgs);
    // Defensive re-parse — the runner already validated, but a future change
    // could remove that. Cheap insurance.
    const parsedDiff = ShadowModeReportSchema.parse(shadowDiff);

    const legacyExecution = projectLegacyOutcome(parsedDiff.legacy);
    const wineSearchExecution = projectWineSearchOutcome(parsedDiff.wineSearch);

    const legacyError = parsedDiff.legacy.status === 'ok'
      ? undefined
      : parsedDiff.legacy.errorMessage ?? parsedDiff.legacy.status;
    const wineSearchError = parsedDiff.wineSearch.status === 'ok'
      ? undefined
      : parsedDiff.wineSearch.errorMessage ?? parsedDiff.wineSearch.status;

    // Judge each side INDEPENDENTLY (its own answer + observations). A judge
    // failure on one side degrades only that side's dims to null. Skipped
    // entirely when no judge is wired OR the side errored (no answer to judge).
    const query = input.query ?? input.scenario.query;
    const legacyJudge = await this.judgeSide(
      query,
      legacyExecution,
      legacyError,
      input,
    );
    const wineSearchJudge = await this.judgeSide(
      query,
      wineSearchExecution,
      wineSearchError,
      input,
    );

    const legacyScore = this.deps.scorer(
      input.scenario,
      legacyExecution,
      legacyError,
      legacyJudge.judgeScore,
      legacyJudge.faithfulnessScore,
      legacyJudge.judgeReasoning,
    );
    const wineSearchScore = this.deps.scorer(
      input.scenario,
      wineSearchExecution,
      wineSearchError,
      wineSearchJudge.judgeScore,
      wineSearchJudge.faithfulnessScore,
      wineSearchJudge.judgeReasoning,
    );

    const scoreDelta = computeScoreDelta(legacyScore, wineSearchScore);
    const verdict = decideVerdict(scoreDelta);

    return {
      shadowDiff: parsedDiff,
      legacyScore,
      wineSearchScore,
      scoreDelta,
      verdict,
    };
  }

  /**
   * Run the injected judge for one side. Returns the score triple to thread
   * into `scoreScenario`. Each field is `undefined` (→ scorer dim stays null)
   * when:
   *   - no judge is wired,
   *   - the side errored / produced no execution (no answer to judge),
   *   - the judge reported `unavailable` (validation/timeout/refusal/…).
   *
   * Honest "unavailable" path: NEVER fabricates a 0 — undefined leaves the
   * dim null so the scorer drops it from the geo-mean.
   */
  private async judgeSide(
    query: string,
    execution: ScenarioExecutionLike | null,
    error: string | undefined,
    input: ShadowModeScoringInput,
  ): Promise<{
    readonly judgeScore?: number;
    readonly faithfulnessScore?: number;
    readonly judgeReasoning?: string;
  }> {
    const judge = this.deps.judge;
    if (judge === undefined || execution === null || error !== undefined) {
      return {};
    }
    const result = await judge.evaluate({
      query,
      answer: execution.answer,
      groundingObservations: execution.observations,
      requestId: input.requestId,
      ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    });
    if (!result.available) {
      return {};
    }
    return {
      judgeScore: result.score,
      faithfulnessScore: result.faithfulness,
      judgeReasoning: result.reasoning,
    };
  }
}

// ---------------------------------------------------------------------------
// Projection helpers (outcome → execution)
//
// `ShadowModeReport.legacy` / `.wineSearch` are *projected* outcomes (a
// trimmed view used by the shadow-mode differ). The bench scorer needs the
// FULL `ScenarioExecution`. We rebuild a scorer-complete synthetic
// `ScenarioExecution` from the projected outcome: the runner now plumbs
// `observations` through the outcome (Gap-4 close-out), so the scorer's
// `faithfulness` and `contextRecall` dimensions receive grounded text
// instead of degrading to `null`.
//
// Observations come from `outcome.observations` which the runner populates
// by walking:
//   - WineSearchResult.executionSteps[].observations (runner / mini_loop
//     only) — analyzer / router / synthesizer phases never produce
//     grounding.
//   - AgentResult.evidenceFrames[].observationSnapshot (preferred) or
//     step.observation / actionPairs[].observation (fallback).
//
// The outcome field is optional in the Zod schema for backward-compat with
// pre-Gap-4 reports; we default to `[]` here so scoring against an older
// JSONL stream still works (those scenarios will surface null faithfulness,
// which is the documented graceful path).
// ---------------------------------------------------------------------------

function projectLegacyOutcome(
  outcome: ShadowModeOrchestratorOutcome,
): ScenarioExecutionLike | null {
  if (outcome.status !== 'ok' || outcome.answer === undefined) return null;
  return {
    answer: outcome.answer,
    stepCount: outcome.toolNames.length,
    toolCallCount: outcome.toolCallCount,
    toolsUsed: outcome.toolNames.map((tool) => ({ tool })),
    observations: outcome.observations ?? [],
    terminationReason: coerceTerminationReason(outcome.terminationReason),
    totalDurationMs: outcome.totalDurationMs,
    totalTokens: {
      input: outcome.tokenUsage.inputTokens,
      output: outcome.tokenUsage.outputTokens,
    },
  };
}

function projectWineSearchOutcome(
  outcome: ShadowModeOrchestratorOutcome,
): ScenarioExecutionLike | null {
  return projectLegacyOutcome(outcome);
}

// ---------------------------------------------------------------------------
// Re-export the pure adapters so callers with raw `AgentResult` /
// `WineSearchResult` (e.g. a future bench harness that holds the un-projected
// results) can route through the same module. Composition root pattern.
// ---------------------------------------------------------------------------

export { agentResultToScenarioExecution, wineSearchResultToScenarioExecution };

/**
 * Score a single scenario using *raw* orchestrator outputs. Bypasses
 * shadow-mode-runner projection so the scorer sees observations / typed
 * tokens (`cacheReadTokens` etc. are still dropped — see adapter notes).
 *
 * Used by bench harnesses that already have both raw results in hand and
 * want the full grounding signal.
 */
export function scoreRawResults(deps: {
  readonly scorer: BenchScorerFn;
  readonly scenario: AgentBenchmarkScenarioLike;
  readonly legacy?: AgentResult;
  readonly wineSearch?: WineSearchResult;
}): { readonly legacyScore: ScenarioResultLike; readonly wineSearchScore: ScenarioResultLike; readonly scoreDelta: ScoreDelta; readonly verdict: ShadowModeScoringVerdict } {
  const legacyExecution = deps.legacy === undefined
    ? null
    : agentResultToScenarioExecution(deps.legacy);
  const wineSearchExecution = deps.wineSearch === undefined
    ? null
    : wineSearchResultToScenarioExecution(deps.wineSearch);
  const legacyScore = deps.scorer(deps.scenario, legacyExecution,
    deps.legacy === undefined ? 'no legacy result' : undefined);
  const wineSearchScore = deps.scorer(deps.scenario, wineSearchExecution,
    deps.wineSearch === undefined ? 'no wineSearch result' : undefined);
  const scoreDelta = computeScoreDelta(legacyScore, wineSearchScore);
  return {
    legacyScore,
    wineSearchScore,
    scoreDelta,
    verdict: decideVerdict(scoreDelta),
  };
}

// ---------------------------------------------------------------------------
// Termination coercion (outcome.terminationReason is a free-form string in
// the ShadowModeReport schema; the bench scorer expects the narrow union)
// ---------------------------------------------------------------------------

function coerceTerminationReason(s: string): ScenarioTerminationReason {
  switch (s) {
    case 'answer':
    case 'fallback':
    case 'blocked':
    case 'error':
    case 'timeout':
      return s;
    case 'max_steps':
    case 'budget':
    case 'loop_detected':
    case 'aborted':
      return 'fallback';
    default:
      return 'error';
  }
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/**
 * Numeric dimensions inspected for per-dimension regression analysis. We
 * intentionally pick the *core* score axes; null-valued RAGAS dims
 * (`faithfulness` / `contextRelevance` / `contextRecall`) are skipped per
 * scenario when their owning side returned `null` (the scorer's documented
 * "DROPPED from geo-mean" semantics).
 */
const SCORE_DIMENSIONS = [
  'executionEfficiency',
  'answerQuality',
  'terminationCorrectness',
  'costEfficiency',
  'faithfulness',
  'contextRelevance',
  'contextRecall',
  'judge',
] as const;

type DimensionKey = (typeof SCORE_DIMENSIONS)[number];

function readDim(
  result: ScenarioResultLike,
  key: DimensionKey,
): number | null {
  const v = result.scores[key];
  return typeof v === 'number' ? v : null;
}

export function computeScoreDelta(
  legacy: ScenarioResultLike,
  wineSearch: ScenarioResultLike,
): ScoreDelta {
  const perDimension: Record<string, number> = {};
  const regressedDimensions: string[] = [];
  for (const key of SCORE_DIMENSIONS) {
    const l = readDim(legacy, key);
    const w = readDim(wineSearch, key);
    // Skip when either side reported null — the dim is dropped from the
    // scorer's geo-mean too, so it doesn't belong in the delta either.
    if (l === null || w === null) continue;
    const delta = w - l;
    perDimension[key] = delta;
    // FP wobble tolerance: a delta that subtracts to exactly `-THRESHOLD`
    // may surface as `-THRESHOLD - 1e-17` in IEEE-754. Subtract EPSILON
    // from the comparison side so the boundary case isn't flagged.
    if (delta < -(SHADOW_SCORE_REGRESSION_THRESHOLD + SHADOW_SCORE_FP_EPSILON)) {
      regressedDimensions.push(key);
    }
  }
  const legacyOverall = errorSafeOverall(legacy);
  const wineSearchOverall = errorSafeOverall(wineSearch);
  const totalDelta = wineSearchOverall - legacyOverall;
  return {
    totalDelta,
    perDimension,
    regressedDimensions,
  };
}

function errorSafeOverall(result: ScenarioResultLike): number {
  if (result.error !== undefined) return SHADOW_SCORE_ERROR_SENTINEL;
  const v = result.scores.overall;
  return Number.isFinite(v) ? v : SHADOW_SCORE_ERROR_SENTINEL;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export function decideVerdict(delta: ScoreDelta): ShadowModeScoringVerdict {
  const hasRegression = delta.regressedDimensions.length > 0;
  if (hasRegression) return 'regressed';
  // No per-dimension regression → look at the macro signal.
  if (Math.abs(delta.totalDelta) < SHADOW_SCORE_PARITY_EPSILON) {
    return 'parity';
  }
  if (delta.totalDelta > 0) return 'improved';
  // totalDelta is negative but no per-dim regression breached the threshold
  // → small distributed degradation; report as 'mixed'.
  return 'mixed';
}
