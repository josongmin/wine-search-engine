/**
 * AURC-gated threshold optimizer.
 *
 * Find the optimal score threshold that maximizes coverage subject to a
 * maximum allowed risk constraint.
 *
 * Risk = error rate among predictions ABOVE the threshold (i.e., decisions
 * that the system makes). Coverage = fraction of all predictions above
 * the threshold.
 *
 * Use case: pick a confidence threshold for "we're sure enough to act"
 * such that the action's error rate stays below an acceptable level.
 */

/** Fallback threshold when no valid predictions exist. */
const EMPTY_THRESHOLD = 1;
/** Minimum denominator for risk computation. */
const MIN_DENOM = 1;

export interface OptimalThreshold {
  readonly threshold: number;
  readonly coverage: number;
  readonly risk: number;
  readonly sampleSize: number;
}

interface ThresholdConstraints {
  /** Maximum allowed risk among predictions above the threshold (0..1). */
  readonly maxRisk: number;
  /** Optional minimum coverage requirement. */
  readonly minCoverage?: number;
}

interface IndexedPrediction {
  score: number;
  correct: boolean;
  index: number;
}

/**
 * Find the optimal threshold satisfying the risk constraint.
 *
 * Algorithm:
 *   1. Sort predictions by score DESCENDING (highest confidence first).
 *      Stable tie-break by original index.
 *   2. Walk the sorted list, tracking cumulative correct/total at each prefix.
 *        coverage(k) = k / N
 *        risk(k) = (k - correctSoFar) / k
 *   3. Find the LARGEST k where risk(k) <= maxRisk — the score at index k-1
 *      becomes the threshold.
 *   4. If minCoverage is set and not achievable under maxRisk, fall back to
 *      the smallest k meeting minCoverage with the lowest risk observed so far.
 */
export function findOptimalThreshold(
  predictions: readonly { readonly score: number; readonly correct: boolean }[],
  constraints: ThresholdConstraints,
): OptimalThreshold {
  const indexed: IndexedPrediction[] = [];
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i]!;
    if (!Number.isFinite(p.score)) continue;
    indexed.push({ score: p.score, correct: p.correct, index: i });
  }

  if (indexed.length === 0) {
    return { threshold: EMPTY_THRESHOLD, coverage: 0, risk: 0, sampleSize: 0 };
  }

  // Stable descending sort with index tiebreaker.
  indexed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  const N = indexed.length;
  const maxRisk = Number.isFinite(constraints.maxRisk) ? constraints.maxRisk : 0;
  const minCoverage =
    constraints.minCoverage !== undefined && Number.isFinite(constraints.minCoverage)
      ? constraints.minCoverage
      : undefined;

  let bestK = -1;
  let bestRisk = 0;
  let correctSoFar = 0;

  // Track the best "minCoverage fallback": smallest k meeting minCoverage with lowest risk.
  let fallbackK = -1;
  let fallbackRisk = Number.POSITIVE_INFINITY;

  for (let k = 1; k <= N; k++) {
    if (indexed[k - 1]!.correct) correctSoFar++;
    const denom = Math.max(k, MIN_DENOM);
    const risk = (k - correctSoFar) / denom;
    const coverage = k / N;

    if (risk <= maxRisk) {
      // Prefer the LARGEST k (maximum coverage) meeting the risk constraint.
      bestK = k;
      bestRisk = risk;
    }

    if (minCoverage !== undefined && coverage >= minCoverage) {
      if (risk < fallbackRisk) {
        fallbackRisk = risk;
        fallbackK = k;
      }
    }
  }

  // If minCoverage is specified and not met by the best risk-constrained solution,
  // use the fallback (best-risk point that meets minCoverage).
  if (minCoverage !== undefined) {
    const bestCoverage = bestK > 0 ? bestK / N : 0;
    if (bestCoverage < minCoverage && fallbackK > 0) {
      const threshold = indexed[fallbackK - 1]!.score;
      return {
        threshold,
        coverage: fallbackK / N,
        risk: fallbackRisk,
        sampleSize: N,
      };
    }
  }

  if (bestK <= 0) {
    // Nothing satisfies the risk constraint — return a threshold above the max score.
    const maxScore = indexed[0]!.score;
    return {
      threshold: maxScore + 1,
      coverage: 0,
      risk: 0,
      sampleSize: N,
    };
  }

  const threshold = indexed[bestK - 1]!.score;
  return {
    threshold,
    coverage: bestK / N,
    risk: bestRisk,
    sampleSize: N,
  };
}
