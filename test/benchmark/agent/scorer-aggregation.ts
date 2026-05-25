/**
 * Aggregate helpers — weight normalization, geometric mean, run-level aggregation.
 *
 * Split from {@link ./scorer.ts} during the cleanup decomposition (2026-05-25).
 * The public surface is re-exported by `./scorer.ts` so external callers
 * (test/benchmark/agent/runner.ts, etc.) keep working unchanged.
 *
 * No domain-specific logic here — purely numeric / structural helpers used by
 * `scoreScenario` (per-scenario weighted geo-mean with null-drop) and by the
 * run-level report builder (aggregateGeoMean / aggregateTrimmedGeoMean).
 */

import { TRIMMED_GEOMEAN_PROPORTION } from './constants.js';

/** Clamp a number into the [0,1] range. NaN/Infinity → 0 (matches the
 *  conservative pre-split behaviour: invalid inputs are treated as zero
 *  rather than mapped to the upper bound). */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Renormalise weights so they sum to 1.0. Used after merging partial
 * scenario overrides over tier defaults so users can set "terminationCorrectness: 0.80"
 * as a ratio-style boost without manually balancing the other dims.
 */
/** Float-comparison tolerance for "weights already sum to 1.0" early-exit. */
const WEIGHT_SUM_UNITY_EPSILON = 1e-9;

export function renormaliseWeights<W extends Record<string, number>>(weights: W): W {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum <= 0 || !Number.isFinite(sum)) return weights;
  if (Math.abs(sum - 1) < WEIGHT_SUM_UNITY_EPSILON) return weights;
  const factor = 1 / sum;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(weights)) {
    result[key] = value * factor;
  }
  return result as W;
}

/** Minimum score floor for non-critical dimensions before geo-mean computation.
 *  Prevents a single weak (but non-critical) dim from collapsing overall by >20x. */
export const DIMENSION_FLOOR = 0.05;

/**
 * Dimensions that intentionally receive NO floor treatment before geo-mean.
 * These are primary outcome / safety dimensions where flooring would hide a
 * real failure signal instead of merely smoothing noisy measurement.
 * Defined at module scope: deterministic constant, no per-call allocation (rule 16).
 */
export const NO_FLOOR_DIMS: ReadonlySet<string> = new Set<string>([
  'executionEfficiency',
  'terminationCorrectness',
  'answerQuality',
  // judge is intentionally NOT in NO_FLOOR_DIMS (v5): LLM judge scores are noisy
  // even with N=3 median. A 0.00 judge collapses the geo-mean to ~12% which is
  // disproportionate — the agent may have answered reasonably but the judge's rubric
  // evaluation was overly strict. DIMENSION_FLOOR=0.05 caps the penalty at ~10x
  // rather than ~1000x (log(0.05) vs log(1e-6)).
  'costEfficiency',  // v4: 2x budget overshoot (score=0) is an engineering failure, not noise.
                     // Flooring it to 0.05 reduced the log-space penalty by 10.8x.
]);

/**
 * Weighted geometric mean with NULL-DROP for missing dimensions (SOTA++ v4).
 *
 * When a dimension's score is null (e.g. judge disabled, faithfulness unmeasured),
 * the dimension is EXCLUDED from the computation entirely — its weight is dropped
 * from the denominator and the remaining weights are renormalized.
 *
 * The null-drop approach eliminates the systematic drag of fixed 0.5 imputation
 * (which capped --no-judge runs at ~84%). The remaining present dims are scored
 * on their own merits with renormalized weights.
 *
 * Monotonicity: adding a real score for a previously-null dim ALWAYS changes the
 * overall in the direction determined by whether the new score is above or below
 * the present-dims geometric mean. This is the standard approach in RAGAS and
 * academic agent benchmarks (null metrics are excluded, not imputed).
 */
export function weightedGeometricMean(
  dimScores: Record<string, number | null>,
  weights: Record<string, number>,
): number {
  const EPS = 1e-6;
  // Null-drop: only present (non-null) dims participate. Null dims are excluded
  // entirely — their weight is NOT in the denominator.
  let weightedLogSum = 0;
  let presentWeight = 0;
  for (const key of Object.keys(weights)) {
    const w = weights[key]!;
    const x = dimScores[key];
    if (x === null || x === undefined) continue; // null-drop: skip entirely
    weightedLogSum += w * Math.log(clamp01(x) + EPS);
    presentWeight += w;
  }
  if (presentWeight === 0) return 0; // degenerate: no dims have scores
  // Do NOT subtract EPS here — EPS was added to log() inputs only to prevent
  // log(0)=-Infinity. Subtracting it from exp() output introduces a systematic
  // negative bias: for a perfect score (x=1), exp(log(1+1e-6))−1e-6 ≈ 0, which
  // would clamp incorrectly. Let clamp01 handle any float rounding artefact.
  const raw = Math.exp(weightedLogSum / presentWeight);
  return clamp01(raw);
}

// ─────────────────────────────────────────────────────────────────────
// Aggregate helpers (run-level — used by runner.ts to build the report)
// ─────────────────────────────────────────────────────────────────────

/**
 * Unweighted geometric mean of a series of [0,1] values (e.g. per-scenario
 * `overall` scores). Critical failures (0) survive intact — the geo-mean is
 * intentionally dominated by them so a run-wide regression cannot hide behind
 * good-scenario averages.
 *
 * Mirrors the EPS=1e-6 floor used by {@link weightedGeometricMean} so a single
 * 0 maps to `Math.exp(log(1e-6))` ≈ 0 rather than `-Infinity`.
 */
export function aggregateGeoMean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const EPS = 1e-6;
  let logSum = 0;
  for (const v of values) {
    logSum += Math.log(Math.max(clamp01(v), EPS));
  }
  return clamp01(Math.exp(logSum / values.length));
}

/**
 * 5%-trimmed geometric mean — robust to heavy-left-tailed score distributions
 * dominated by a handful of critical failures (score=0).
 *
 * Implementation: sort ascending, drop ⌊TRIMMED_GEOMEAN_PROPORTION × N⌋ values
 * from EACH tail, geo-mean the remainder. When the survivor set is empty
 * (`N < ⌈1/TRIMMED_GEOMEAN_PROPORTION⌉` − e.g. N≤9 at 5% trim leaves zero
 * survivors after symmetric trimming) we fall back to the untrimmed geo-mean
 * to avoid reporting `0` for a small healthy run.
 *
 * Critical failures (raw 0 values) STAY counted via the discrete
 * `criticalFailureCount` channel in the report — the bench surfaces both
 * trimmed and raw aggregates AND the critical count side-by-side so trimming
 * never squelches the security/correctness signal (CLAUDE.md execution baseline
 * + metric-spec.md §A2).
 */
export function aggregateTrimmedGeoMean(
  values: readonly number[],
  proportion: number = TRIMMED_GEOMEAN_PROPORTION,
): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(proportion) || proportion <= 0) {
    return aggregateGeoMean(values);
  }
  const trimCount = Math.floor(values.length * proportion);
  if (trimCount === 0) {
    // Too few samples to trim symmetrically — fall back to raw.
    return aggregateGeoMean(values);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const survivors = sorted.slice(trimCount, sorted.length - trimCount);
  if (survivors.length === 0) {
    // Degenerate: trim window swallowed everything; fall back to raw.
    return aggregateGeoMean(values);
  }
  return aggregateGeoMean(survivors);
}
