/**
 * SOTA++ paired bootstrap significance test for agent benchmark comparisons.
 *
 * Why paired:
 *   Two benchmark runs evaluate the SAME scenarios. The natural per-scenario
 *   variation (scenario A is intrinsically harder than scenario B) is shared
 *   between baseline and current and must cancel out — otherwise we'd waste
 *   variance budget on a nuisance that has nothing to do with the change we're
 *   measuring. The per-scenario delta `current[id] - baseline[id]` is the
 *   unit of analysis; we resample those deltas (with replacement) B times to
 *   estimate the sampling distribution of mean(Δ).
 *
 * Why bootstrap:
 *   Distribution-free. A paired t-test would assume normally-distributed
 *   deltas; with N=80-200 scenarios and a long-tailed score distribution
 *   (geo-means + critical-fail short-circuits), normality is not safe to
 *   assume. Bootstrap CI is robust under any score distribution.
 *
 * The two-sided p-value uses the standard "twice the smaller tail mass"
 * convention against the null hypothesis mean(Δ)=0. Counts include both
 * tails of resampled means and avoids a zero p-value by using the
 * conservative `(count + 1) / (B + 1)` estimator (Davison & Hinkley 1997).
 *
 * Public surface:
 *   - pairedBootstrap(baseline, current, options) → PairedBootstrapResult
 *   - PairedBootstrapResult — full structured output for runner + docs
 *
 * NO heuristic shortcuts (SOTA++ policy):
 *   - No subsample, no normality fallback, no asymptotic shortcut.
 *   - Seeded PRNG (mulberry32) — reproducible across runs.
 */

const DEFAULT_ITERATIONS = 10_000;
const DEFAULT_ALPHA = 0.05;
/**
 * Mulberry32 seed mixing constant — chosen so independent callers get
 * decorrelated streams even if they share a base integer seed.
 */
const PRNG_SEED_MIX = 0x6D2B79F5;
/** Fallback seed when no explicit seed and dataset is empty (degenerate path). */
const PRNG_FALLBACK_SEED = 0x9E3779B1;
/** mulberry32 internal bit-shift constants (canonical reference algorithm). */
const PRNG_SHIFT_HIGH = 15;
const PRNG_SHIFT_MID = 7;
const PRNG_SHIFT_LOW = 14;
/** mulberry32 odd-mask constants (canonical reference algorithm). */
const PRNG_MASK_HIGH = 61;
/** 2^32 — denominator that maps the unsigned 32-bit hash into [0, 1). */
const PRNG_UINT32_RANGE = 4_294_967_296;
/** Knuth multiplicative-hash constant (golden-ratio-derived). */
const SEED_HASH_KNUTH = 2_654_435_761;
/** CI median percentile (used to report bootstrapMedianDelta). */
const PERCENTILE_MEDIAN = 0.5;
/** Headline p-value precision — small enough to surface 1/(B+1) floor. */
const HEADLINE_PVALUE_DIGITS = 4;
/** Percentage scale factor (× 100 → percent). */
const PERCENT_SCALE = 100;

export interface ScenarioScorePair {
  readonly id: number | string;
  readonly score: number;
}

export interface ScenarioDelta {
  readonly id: number | string;
  readonly delta: number;
  readonly baseline: number;
  readonly current: number;
}

interface PairedBootstrapOptions {
  /** Number of bootstrap resamples. Default 10_000. */
  readonly iterations?: number;
  /** Significance level for the CI. Default 0.05 (95% CI). */
  readonly alpha?: number;
  /** Optional explicit seed for the PRNG; default derives from n. */
  readonly seed?: number;
}

export interface PairedBootstrapResult {
  /** Observed mean per-scenario delta (current − baseline). */
  readonly meanDelta: number;
  /** Number of paired scenarios used. */
  readonly n: number;
  /** Number of bootstrap resamples actually performed. */
  readonly iterations: number;
  /** Confidence interval [lower, upper] at 1-alpha level. */
  readonly ci95: readonly [number, number];
  /** Significance level used. */
  readonly alpha: number;
  /**
   * Two-sided p-value against H0: mean(Δ) = 0. Uses (count+1)/(B+1) so the
   * minimum reportable p-value is `1 / (iterations + 1)` rather than 0.
   */
  readonly pValue: number;
  /** Scenarios with current < baseline, sorted worst-first (most negative). */
  readonly regressedScenarios: readonly ScenarioDelta[];
  /** Scenarios with current > baseline, sorted best-first (most positive). */
  readonly improvedScenarios: readonly ScenarioDelta[];
  /** Standard deviation of the per-scenario deltas (Bessel-corrected). */
  readonly deltaStdev: number;
  /** Median bootstrap mean delta — sanity check vs `meanDelta`. */
  readonly bootstrapMedianDelta: number;
}

/**
 * Mulberry32 — fast, well-distributed 32-bit PRNG. Deterministic given a seed,
 * suitable for reproducible bootstrap resampling. NOT cryptographically
 * secure (and doesn't need to be).
 */
function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return (): number => {
    state = (state + PRNG_SEED_MIX) | 0;
    let t = Math.imul(state ^ (state >>> PRNG_SHIFT_HIGH), 1 | state);
    t = (t + Math.imul(t ^ (t >>> PRNG_SHIFT_MID), PRNG_MASK_HIGH | t)) ^ t;
    return ((t ^ (t >>> PRNG_SHIFT_LOW)) >>> 0) / PRNG_UINT32_RANGE;
  };
}

function buildScenarioMap(
  pairs: readonly ScenarioScorePair[],
): Map<number | string, number> {
  const out = new Map<number | string, number>();
  for (const p of pairs) {
    if (!Number.isFinite(p.score)) continue;
    out.set(p.id, p.score);
  }
  return out;
}

/**
 * Compute paired scenario deltas — scenarios present in BOTH baseline and
 * current contribute one delta. Scenarios in only one side are dropped (and
 * an unpaired count is recoverable from the inputs' lengths if needed).
 *
 * Deterministic ordering: sorts by id (numeric ids by numeric value, mixed
 * types by string projection) so downstream consumers get stable output.
 */
export function buildPairedDeltas(
  baseline: readonly ScenarioScorePair[],
  current: readonly ScenarioScorePair[],
): readonly ScenarioDelta[] {
  const baseMap = buildScenarioMap(baseline);
  const curMap = buildScenarioMap(current);
  const deltas: ScenarioDelta[] = [];
  for (const [id, baseScore] of baseMap) {
    const curScore = curMap.get(id);
    if (curScore === undefined) continue;
    deltas.push({
      id,
      baseline: baseScore,
      current: curScore,
      delta: curScore - baseScore,
    });
  }
  deltas.sort((a, b) => {
    if (typeof a.id === 'number' && typeof b.id === 'number') return a.id - b.id;
    return String(a.id).localeCompare(String(b.id));
  });
  return deltas;
}

function percentileSortedAsc(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.max(0, Math.min(1, p));
  const idx = (sorted.length - 1) * clamped;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  return loVal + (hiVal - loVal) * (idx - lo);
}

/**
 * Paired bootstrap delta test.
 *
 * - Resamples the per-scenario delta array with replacement `iterations` times.
 * - Reports the mean delta, its CI at (1-alpha), and a two-sided p-value
 *   against H0: mean(Δ) = 0.
 * - Returns the worst-regressed and most-improved scenarios for triage.
 *
 * Edge cases:
 *   - Zero paired scenarios → meanDelta=0, ci95=[0,0], p=1 (no signal).
 *   - One paired scenario → ci collapses to that single delta; p=1 (cannot
 *     test against H0 with n=1).
 */
export function pairedBootstrap(
  baseline: readonly ScenarioScorePair[],
  current: readonly ScenarioScorePair[],
  options: PairedBootstrapOptions = {},
): PairedBootstrapResult {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const deltas = buildPairedDeltas(baseline, current);

  const n = deltas.length;
  const deltaValues = deltas.map((d) => d.delta);

  // Sorted partitions for triage output.
  const regressed = deltas
    .filter((d) => d.delta < 0)
    .slice()
    .sort((a, b) => a.delta - b.delta);
  const improved = deltas
    .filter((d) => d.delta > 0)
    .slice()
    .sort((a, b) => b.delta - a.delta);

  if (n === 0) {
    return {
      meanDelta: 0,
      n: 0,
      iterations: 0,
      ci95: [0, 0],
      alpha,
      pValue: 1,
      regressedScenarios: regressed,
      improvedScenarios: improved,
      deltaStdev: 0,
      bootstrapMedianDelta: 0,
    };
  }

  const meanDelta = deltaValues.reduce((s, v) => s + v, 0) / n;

  if (n === 1) {
    const only = deltaValues[0] ?? 0;
    return {
      meanDelta: only,
      n: 1,
      iterations: 0,
      ci95: [only, only],
      alpha,
      pValue: 1,
      regressedScenarios: regressed,
      improvedScenarios: improved,
      deltaStdev: 0,
      bootstrapMedianDelta: only,
    };
  }

  const variance = deltaValues.reduce((s, v) => s + (v - meanDelta) ** 2, 0) / (n - 1);
  const deltaStdev = Math.sqrt(variance);

  const seed = options.seed ?? (n * SEED_HASH_KNUTH) | 0;
  const safeSeed = seed === 0 ? PRNG_FALLBACK_SEED : seed;
  const rand = mulberry32(safeSeed);

  const bootMeans: number[] = new Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand() * n);
      sum += deltaValues[idx] ?? 0;
    }
    bootMeans[b] = sum / n;
  }

  bootMeans.sort((a, b) => a - b);

  const ciLow = percentileSortedAsc(bootMeans, alpha / 2);
  const ciHigh = percentileSortedAsc(bootMeans, 1 - alpha / 2);
  const bootstrapMedianDelta = percentileSortedAsc(bootMeans, PERCENTILE_MEDIAN);

  // Two-sided p-value against H0: mean(Δ)=0. Use the "shift to null" approach:
  // recenter each bootstrap sample mean to (m_b - meanDelta) and count how
  // often |m_b - meanDelta| ≥ |meanDelta|. Equivalent to the standard
  // achieved significance level for paired bootstrap. (count+1)/(B+1) avoids
  // p=0 reports.
  let extreme = 0;
  const absObs = Math.abs(meanDelta);
  for (let b = 0; b < iterations; b++) {
    const centered = (bootMeans[b] ?? 0) - meanDelta;
    if (Math.abs(centered) >= absObs) extreme++;
  }
  const pValue = (extreme + 1) / (iterations + 1);

  return {
    meanDelta,
    n,
    iterations,
    ci95: [ciLow, ciHigh],
    alpha,
    pValue,
    regressedScenarios: regressed,
    improvedScenarios: improved,
    deltaStdev,
    bootstrapMedianDelta,
  };
}

/**
 * Format the canonical one-line summary that ships with the bench report.
 * Example:
 *   `Δoverall = +4.10pp (95% paired CI [+2.30, +5.90]), p=0.0010 (n=104, B=10000)`
 */
export function formatPairedBootstrapHeadline(
  label: string,
  result: PairedBootstrapResult,
): string {
  const fmt = (v: number): string => {
    const pp = v * PERCENT_SCALE;
    const sign = pp >= 0 ? '+' : '';
    return `${sign}${pp.toFixed(2)}pp`;
  };
  const [lo, hi] = result.ci95;
  const ciPct = `${(1 - result.alpha) * PERCENT_SCALE}`;
  return (
    `Δ${label} = ${fmt(result.meanDelta)} `
    + `(${ciPct}% paired CI [${fmt(lo)}, ${fmt(hi)}]), `
    + `p=${result.pValue.toFixed(HEADLINE_PVALUE_DIGITS)} (n=${result.n}, B=${result.iterations})`
  );
}
