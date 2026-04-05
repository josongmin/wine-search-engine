/**
 * Statistical significance testing for IR metric comparisons.
 *
 * Implements paired bootstrap test with Bonferroni correction
 * for multiple comparisons (RFC-017 §3.2).
 *
 * All functions are pure — no I/O.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  /** Two-sided p-value. */
  readonly p_value: number;
  /** 95% confidence interval for (candidate - baseline) difference. */
  readonly ci_95: readonly [number, number];
  /** Mean difference (candidate - baseline). */
  readonly mean_diff: number;
  /** Whether improvement is significant at the given alpha level. */
  readonly significant: boolean;
}

export interface MultiComparisonResult {
  readonly raw_results: ReadonlyMap<string, BootstrapResult>;
  /** Bonferroni-corrected alpha. */
  readonly corrected_alpha: number;
  /** Which metrics show significant improvement after correction. */
  readonly significant_metrics: readonly string[];
}

// ---------------------------------------------------------------------------
// Seeded RNG for reproducibility
// ---------------------------------------------------------------------------

/**
 * Simple xoshiro128** PRNG from a 32-bit seed.
 * Deterministic for reproducibility; NOT cryptographic.
 */
function createRng(seed: number): () => number {
  let s0 = seed | 0x9E3779B9;
  let s1 = seed ^ 0x6A09E667;
  let s2 = seed ^ 0xBB67AE85;
  let s3 = seed ^ 0x3C6EF372;

  return (): number => {
    const result = (((s1 * 5) << 7 | (s1 * 5) >>> 25) * 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11 | s3 >>> 21);
    return result / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Paired Bootstrap Test
// ---------------------------------------------------------------------------

/**
 * Paired bootstrap test: tests whether candidate per-query metrics
 * are significantly better than baseline per-query metrics.
 *
 * H0: mean(candidate) <= mean(baseline)
 * H1: mean(candidate) > mean(baseline)
 *
 * @param baselinePerQuery Per-query metric values for baseline system.
 * @param candidatePerQuery Per-query metric values for candidate system.
 * @param B Number of bootstrap resamples (default 10,000).
 * @param alpha Significance level (default 0.05).
 * @param seed RNG seed for reproducibility.
 */
export function pairedBootstrap(
  baselinePerQuery: readonly number[],
  candidatePerQuery: readonly number[],
  B = 10_000,
  alpha = 0.05,
  seed = 42,
): BootstrapResult {
  const n = baselinePerQuery.length;
  if (n !== candidatePerQuery.length) {
    throw new Error(
      `Paired arrays must have equal length: ${n} vs ${candidatePerQuery.length}`,
    );
  }
  if (n === 0) {
    return { p_value: 1, ci_95: [0, 0], mean_diff: 0, significant: false };
  }

  // Observed difference
  const diffs = baselinePerQuery.map((b, i) => candidatePerQuery[i]! - b);
  const observedDiff = diffs.reduce((a, b) => a + b, 0) / n;

  const rng = createRng(seed);
  const bootstrapDiffs: number[] = [];

  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng() * n);
      sum += diffs[idx]!;
    }
    bootstrapDiffs.push(sum / n);
  }

  // Sort for percentiles
  bootstrapDiffs.sort((a, b) => a - b);

  // p-value: fraction of bootstrap diffs <= 0 (one-sided improvement test)
  const countLessEqual = bootstrapDiffs.filter((d) => d <= 0).length;
  const pValue = countLessEqual / B;

  // 95% CI
  const lowerIdx = Math.floor(0.025 * B);
  const upperIdx = Math.floor(0.975 * B);
  const ci95: [number, number] = [
    bootstrapDiffs[lowerIdx] ?? 0,
    bootstrapDiffs[upperIdx] ?? 0,
  ];

  return {
    p_value: pValue,
    ci_95: ci95,
    mean_diff: observedDiff,
    significant: pValue < alpha,
  };
}

// ---------------------------------------------------------------------------
// Bonferroni Correction for Multiple Comparisons
// ---------------------------------------------------------------------------

/**
 * Run paired bootstrap on multiple metrics simultaneously, applying
 * Bonferroni correction to control family-wise error rate.
 *
 * @param metrics Map of metric_name → [baseline_per_query, candidate_per_query].
 * @param alpha Family-wise significance level (default 0.05).
 * @param B Number of bootstrap resamples per metric.
 */
export function multipleComparison(
  metrics: ReadonlyMap<string, { baseline: readonly number[]; candidate: readonly number[] }>,
  alpha = 0.05,
  B = 10_000,
): MultiComparisonResult {
  const numComparisons = metrics.size;
  const correctedAlpha = alpha / numComparisons;

  const rawResults = new Map<string, BootstrapResult>();
  const significantMetrics: string[] = [];

  for (const [name, { baseline, candidate }] of metrics) {
    const result = pairedBootstrap(baseline, candidate, B, correctedAlpha);
    rawResults.set(name, result);
    if (result.significant) {
      significantMetrics.push(name);
    }
  }

  return {
    raw_results: rawResults,
    corrected_alpha: correctedAlpha,
    significant_metrics: significantMetrics,
  };
}
