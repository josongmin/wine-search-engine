import type { EvalResult } from '../model/eval-result.js';

/**
 * A single point on the risk-coverage curve.
 */
interface RiskCoveragePoint {
  /** Fraction of cases covered at this threshold (0–1). */
  readonly coverage: number;

  /** Wrong-resolve risk at this coverage level. */
  readonly risk: number;
}

/**
 * Implements Selective Prediction metrics for the evaluation framework,
 * per RFC-009 §7.
 *
 * Selective prediction measures the engine's ability to "know what it
 * doesn't know" — by ranking predictions by confidence and evaluating
 * accuracy at various coverage levels, we can quantify how well the
 * confidence scores support selective answering.
 */
export class SelectivePredictor {
  /**
   * Sorts results by confidence descending and groups into coverage bins.
   *
   * @param results - Evaluation results to bin.
   * @param bins - Number of coverage bins (default: 10).
   * @returns Array of result groups, one per bin, from highest to lowest confidence.
   */
  sortByCoverageBins(
    results: readonly EvalResult[],
    bins: number = 10,
  ): readonly (readonly EvalResult[])[] {
    if (results.length === 0) return [];

    const sorted = [...results].sort(
      (a, b) => b.decisionConfidence - a.decisionConfidence,
    );

    const binSize = Math.ceil(sorted.length / bins);
    const groups: EvalResult[][] = [];

    for (let i = 0; i < bins; i++) {
      const start = i * binSize;
      const end = Math.min(start + binSize, sorted.length);
      if (start < sorted.length) {
        groups.push(sorted.slice(start, end));
      }
    }

    return groups;
  }

  /**
   * Computes the wrong-resolve risk at a given coverage level.
   *
   * Coverage is defined as the fraction of cases the engine answers
   * (sorted by confidence descending). Risk is the wrong-resolve rate
   * among answered cases.
   *
   * @param results - Evaluation results.
   * @param coverage - Coverage level in (0, 1].
   * @returns The wrong-resolve risk at the specified coverage.
   */
  computeRiskAtCoverage(results: readonly EvalResult[], coverage: number): number {
    if (results.length === 0) return 0;

    const sorted = [...results].sort(
      (a, b) => b.decisionConfidence - a.decisionConfidence,
    );

    const n = Math.max(1, Math.round(sorted.length * coverage));
    const covered = sorted.slice(0, n);
    const wrongResolves = covered.filter((r) => r.isWrongResolve).length;

    return wrongResolves / covered.length;
  }

  /**
   * Computes the Area Under Risk-Coverage curve using the trapezoidal rule,
   * per RFC-009 §7.
   *
   * Lower AURC indicates better selective prediction — the engine
   * concentrates its errors in low-confidence predictions that would
   * be abstained on.
   *
   * @param results - Evaluation results.
   * @param steps - Number of integration steps (default: 100).
   * @returns The AURC value.
   */
  computeAURC(results: readonly EvalResult[], steps: number = 100): number {
    if (results.length === 0) return 0;

    const curve = this.computeRiskCoverageCurve(results, steps);
    return this.integrateTrapezoidal(curve);
  }

  /**
   * Computes the Excess AURC — AURC minus the optimal AURC that an
   * oracle selector (which always rejects errors first) would achieve.
   *
   * E-AURC isolates the quality of the confidence ranking from the
   * overall error rate.
   *
   * @param results - Evaluation results.
   * @param steps - Number of integration steps (default: 100).
   * @returns The E-AURC value (non-negative).
   */
  computeEAURC(results: readonly EvalResult[], steps: number = 100): number {
    if (results.length === 0) return 0;

    const aurc = this.computeAURC(results, steps);
    const optimalAurc = this.computeOptimalAURC(results, steps);

    return Math.max(0, aurc - optimalAurc);
  }

  /**
   * Computes the full risk-coverage curve.
   *
   * @param results - Evaluation results.
   * @param steps - Number of points on the curve (default: 100).
   * @returns Array of coverage-risk points from coverage=0 to coverage=1.
   */
  computeRiskCoverageCurve(
    results: readonly EvalResult[],
    steps: number = 100,
  ): readonly RiskCoveragePoint[] {
    if (results.length === 0) return [];

    const points: RiskCoveragePoint[] = [];

    for (let i = 1; i <= steps; i++) {
      const coverage = i / steps;
      const risk = this.computeRiskAtCoverage(results, coverage);
      points.push({ coverage, risk });
    }

    return points;
  }

  /**
   * Builds a coverage-to-risk map at the specified step granularity.
   *
   * @param results - Evaluation results.
   * @param steps - Number of coverage steps (default: 10).
   * @returns Map from coverage level to risk.
   */
  computeSelectiveRiskMap(
    results: readonly EvalResult[],
    steps: number = 10,
  ): ReadonlyMap<number, number> {
    const map = new Map<number, number>();

    for (let i = 1; i <= steps; i++) {
      const coverage = i / steps;
      const risk = this.computeRiskAtCoverage(results, coverage);
      map.set(coverage, risk);
    }

    return map;
  }

  /**
   * Computes the optimal AURC (oracle selector that rejects all errors first).
   * In the optimal case, wrong resolves are placed at the lowest-confidence
   * end, so errors only appear at high coverage.
   */
  private computeOptimalAURC(
    results: readonly EvalResult[],
    steps: number,
  ): number {
    // Oracle sorts: correct results first, wrong resolves last
    const oracleSorted = [...results].sort((a, b) => {
      const aErr = a.isWrongResolve ? 1 : 0;
      const bErr = b.isWrongResolve ? 1 : 0;
      return aErr - bErr;
    });

    const points: RiskCoveragePoint[] = [];

    for (let i = 1; i <= steps; i++) {
      const coverage = i / steps;
      const n = Math.max(1, Math.round(oracleSorted.length * coverage));
      const covered = oracleSorted.slice(0, n);
      const wrongResolves = covered.filter((r) => r.isWrongResolve).length;
      const risk = wrongResolves / covered.length;
      points.push({ coverage, risk });
    }

    return this.integrateTrapezoidal(points);
  }

  /**
   * Numerically integrates a risk-coverage curve using the trapezoidal rule.
   */
  private integrateTrapezoidal(points: readonly RiskCoveragePoint[]): number {
    if (points.length < 2) return 0;

    let area = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i]!.coverage - points[i - 1]!.coverage;
      const avgRisk = (points[i]!.risk + points[i - 1]!.risk) / 2;
      area += dx * avgRisk;
    }

    return area;
  }
}
