/**
 * AURC-derived refusal-threshold derivation (P0.2).
 *
 * Selective prediction (Geifman & El-Yaniv 2017, "Selective Classification for
 * Deep Neural Networks") chooses the operating point τ on the risk-coverage
 * curve such that coverage ≥ target_coverage with minimum observed risk.
 *
 * This module is the pure, testable core: given (score, isCorrect, queryClass)
 * triples and a target coverage in (0, 1], it returns the threshold τ for
 * each query class along with the diagnostic AURC and observed risk at the
 * operating point. The runtime CLI and the regression test both share this
 * function so the derivation logic is exercised in one place.
 *
 * SOTA notes:
 *  - We reuse `computeAURC` from the calibration suite for the curve and the
 *    AURC scalar so the curve generation is a single source of truth.
 *  - For τ we walk the prefix of the descending-sorted scores at the chosen
 *    coverage point and take the score at the boundary. This produces the
 *    largest τ that still admits ≥ target_coverage of the population, which
 *    matches Geifman & El-Yaniv's "maximum-coverage selective classifier
 *    at target risk" formulation rotated for the coverage-pinned variant.
 */

import { computeAURC } from './aurc.js';

/** One labelled, calibrated prediction. */
export interface RefusalDerivationSample {
  /** Calibrated score in [0,1]. Non-finite samples are silently dropped. */
  readonly score: number;
  /** Whether the prediction was correct against the gold label. */
  readonly isCorrect: boolean;
  /** Query-class key (e.g. wine_name, producer, general). */
  readonly queryClass: string;
}

interface RefusalDerivationResult {
  readonly queryClass: string;
  /** Calibrated probability τ ∈ [0,1]. */
  readonly threshold: number;
  /** Operating point on the AURC curve. */
  readonly targetCoverage: number;
  /** Observed risk at the operating point (error rate among admitted). */
  readonly riskAtCoverage: number;
  /** Number of samples that fed the fit. */
  readonly sampleSize: number;
  /** AURC of the curve used to derive τ. */
  readonly aurc: number;
}

interface RefusalDerivationOptions {
  /** Operating point in (0,1]. */
  readonly targetCoverage: number;
}

/**
 * Bucket samples by `queryClass`. Pure function; exported for re-use by the
 * regression test which seeds heterogeneous eval rows.
 */
export function groupByQueryClass(
  samples: readonly RefusalDerivationSample[],
): ReadonlyMap<string, readonly RefusalDerivationSample[]> {
  const out = new Map<string, RefusalDerivationSample[]>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.score)) continue;
    const bucket = out.get(sample.queryClass);
    if (bucket === undefined) {
      out.set(sample.queryClass, [sample]);
    } else {
      bucket.push(sample);
    }
  }
  return out;
}

/**
 * Derive τ for a single query class.
 *
 * Algorithm:
 *  1. Drop non-finite scores defensively (computeAURC already filters but we
 *     also need finite scores for our boundary lookup).
 *  2. Sort descending by score; tie-break by original index for stability.
 *  3. Compute the AURC curve and the scalar AURC via the SSoT.
 *  4. Walk the curve to find the smallest index k where coverage ≥ target.
 *     The threshold τ is the score at position (k-1) — the lowest score
 *     still admitted at the chosen coverage.
 *  5. Read the observed risk at that operating point straight off the curve.
 */
export function deriveRefusalThresholdForClass(
  queryClass: string,
  samples: readonly RefusalDerivationSample[],
  options: RefusalDerivationOptions,
): RefusalDerivationResult {
  const { targetCoverage } = options;
  if (!Number.isFinite(targetCoverage) || targetCoverage <= 0 || targetCoverage > 1) {
    throw new Error(
      `[refusal-threshold] targetCoverage must be in (0, 1], got ${targetCoverage}`,
    );
  }
  const finite = samples.filter((s) => Number.isFinite(s.score));
  if (finite.length === 0) {
    throw new Error(
      `[refusal-threshold] cannot derive threshold for class "${queryClass}" with zero finite samples`,
    );
  }

  // Stable descending sort for τ boundary lookup.
  const indexed = finite.map((s, i) => ({ ...s, originalIndex: i }));
  indexed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  const aurcInputs = indexed.map((s) => ({ confidence: s.score, correct: s.isCorrect }));
  const aurc = computeAURC(aurcInputs);

  const N = indexed.length;
  // Walk for the first prefix length k where coverage = k / N is ≥ targetCoverage.
  // Math.ceil is the "≥50%-style threshold" used per CLAUDE.md rule 18: we want
  // the SMALLEST k that still meets the target so τ is the LARGEST admissible
  // score. For N=1 this collapses to k=1 (cover everything).
  const minK = Math.max(1, Math.ceil(targetCoverage * N));
  const kIndex = minK - 1;
  const boundarySample = indexed[kIndex];
  if (boundarySample === undefined) {
    throw new Error(
      `[refusal-threshold] internal: boundary index ${kIndex} out of bounds for class "${queryClass}"`,
    );
  }
  const threshold = boundarySample.score;

  const curvePoint = aurc.curve[kIndex];
  const riskAtCoverage = curvePoint?.risk ?? 0;
  const observedCoverage = curvePoint?.coverage ?? minK / N;

  return {
    queryClass,
    threshold,
    targetCoverage: observedCoverage,
    riskAtCoverage,
    sampleSize: N,
    aurc: aurc.aurc,
  };
}

/**
 * Derive τ for every query class present in `samples`. Classes with fewer
 * samples than `minSamplesPerClass` are returned in `skipped` instead of
 * `fitted`; the caller decides whether to error out (the CLI script does)
 * or proceed with the partial fit (the in-process regression suite may).
 */
export function deriveRefusalThresholds(
  samples: readonly RefusalDerivationSample[],
  options: RefusalDerivationOptions & { readonly minSamplesPerClass: number },
): {
  readonly fitted: readonly RefusalDerivationResult[];
  readonly skipped: readonly { readonly queryClass: string; readonly sampleSize: number }[];
} {
  const grouped = groupByQueryClass(samples);
  const fitted: RefusalDerivationResult[] = [];
  const skipped: { queryClass: string; sampleSize: number }[] = [];

  for (const [queryClass, bucket] of grouped) {
    if (bucket.length < options.minSamplesPerClass) {
      skipped.push({ queryClass, sampleSize: bucket.length });
      continue;
    }
    fitted.push(
      deriveRefusalThresholdForClass(queryClass, bucket, {
        targetCoverage: options.targetCoverage,
      }),
    );
  }

  // Deterministic ordering so the JSON report diff is stable.
  fitted.sort((a, b) => a.queryClass.localeCompare(b.queryClass));
  skipped.sort((a, b) => a.queryClass.localeCompare(b.queryClass));
  return { fitted, skipped };
}
