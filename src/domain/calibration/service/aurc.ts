/**
 * AURC (Area Under Risk-Coverage curve) — selective prediction quality.
 *
 * Reference: El-Yaniv & Wiener 2010, "On the Foundations of Noise-free
 * Selective Classification"; Geifman et al. 2019 "SelectiveNet".
 *
 * Lower AURC = better calibration (the model's confidence ordering
 * separates correct from incorrect predictions well).
 */

export interface RiskCoveragePoint {
  readonly coverage: number;
  readonly risk: number;
}

export interface AURCResult {
  readonly aurc: number;
  readonly coverage_at_risk_5pct: number;
  readonly coverage_at_risk_10pct: number;
  readonly coverage_at_risk_20pct: number;
  readonly curve: readonly RiskCoveragePoint[];
}

/** Default risk thresholds for coverage_at_risk_X pct fields. */
const RISK_THRESHOLD_5 = 0.05;
const RISK_THRESHOLD_10 = 0.10;
const RISK_THRESHOLD_20 = 0.20;

const EMPTY_RESULT: AURCResult = {
  aurc: 0,
  coverage_at_risk_5pct: 0,
  coverage_at_risk_10pct: 0,
  coverage_at_risk_20pct: 0,
  curve: [],
};

/**
 * Compute AURC from a set of (confidence, correct) predictions.
 *
 * Algorithm:
 *   1. Sort predictions by confidence DESCENDING (highest confidence first).
 *      Tie-break by index for stable ordering.
 *   2. Walk the sorted list; at prefix length k:
 *        coverage = k / N
 *        errors_so_far = k - correct_so_far
 *        risk = errors_so_far / k
 *   3. AURC = trapezoidal numerical integration of risk over coverage.
 *   4. coverage_at_risk_X = max coverage where risk ≤ X.
 */
export function computeAURC(
  predictions: readonly { readonly confidence: number; readonly correct: boolean }[],
): AURCResult {
  if (predictions.length === 0) {
    return EMPTY_RESULT;
  }

  // Stable sort: predictions[i] tagged with original index for tie-break.
  const indexed: { confidence: number; correct: boolean; index: number }[] = [];
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i]!;
    if (!Number.isFinite(p.confidence)) continue;
    indexed.push({ confidence: p.confidence, correct: p.correct, index: i });
  }
  if (indexed.length === 0) return EMPTY_RESULT;

  indexed.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.index - b.index;
  });

  const N = indexed.length;
  const curve: RiskCoveragePoint[] = [];
  let correctSoFar = 0;
  let coverageAtRisk5 = 0;
  let coverageAtRisk10 = 0;
  let coverageAtRisk20 = 0;

  for (let k = 1; k <= N; k++) {
    if (indexed[k - 1]!.correct) correctSoFar++;
    const coverage = k / N;
    const risk = (k - correctSoFar) / k;
    curve.push({ coverage, risk });
    if (risk <= RISK_THRESHOLD_5) coverageAtRisk5 = coverage;
    if (risk <= RISK_THRESHOLD_10) coverageAtRisk10 = coverage;
    if (risk <= RISK_THRESHOLD_20) coverageAtRisk20 = coverage;
  }

  // Trapezoidal AURC: ∫ risk d(coverage) over [0, 1].
  // The first coverage step is 1/N, so we use a left-Riemann from coverage=0
  // (where risk is undefined → take the first point's risk as left boundary).
  let aurc = 0;
  for (let i = 0; i < curve.length; i++) {
    const cur = curve[i]!;
    const prev = i === 0 ? { coverage: 0, risk: cur.risk } : curve[i - 1]!;
    const dx = cur.coverage - prev.coverage;
    const avgRisk = (cur.risk + prev.risk) / 2;
    aurc += dx * avgRisk;
  }

  return {
    aurc,
    coverage_at_risk_5pct: coverageAtRisk5,
    coverage_at_risk_10pct: coverageAtRisk10,
    coverage_at_risk_20pct: coverageAtRisk20,
    curve,
  };
}
