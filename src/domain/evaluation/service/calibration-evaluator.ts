/**
 * E5-U5: Calibrator Activation Prerequisites
 *
 * Prerequisites for calibrator activation:
 *   1. Sufficient eval sample size — minimum case count must be met before ECE
 *      measurements are statistically meaningful.
 *   2. Baseline score distribution — confidence scores must cover the full [0, 1]
 *      range with adequate bin density; sparse distributions invalidate ECE.
 *   3. Feature stability — the feature set driving confidence scores must be
 *      stable (no in-flight schema or weight changes) at the time of calibration.
 *
 * Calibrator MUST NOT activate unless all prerequisites pass; see
 * search-usecase-ranked-route-resolve.ts for insertion point (E3-U6).
 */

import type { QueryClass } from '../../shared/types/index.js';
import type { EvalResult } from '../model/eval-result.js';
import type { EvalCase } from '../model/eval-case.js';

/** Midpoint offset for bin center in reliability diagram (equal-width bins). */
const RELIABILITY_BIN_CENTER_OFFSET = 0.5;

/**
 * A single bin in a reliability diagram.
 */
interface ReliabilityBin {
  /** Center of this confidence bin (e.g. 0.05, 0.15, ..., 0.95). */
  readonly binCenter: number;

  /** Mean predicted confidence for results in this bin. */
  readonly avgConfidence: number;

  /** Mean accuracy (correct-resolve rate) for results in this bin. */
  readonly avgAccuracy: number;

  /** Number of results in this bin. */
  readonly count: number;
}

/**
 * Per-query-class ECE breakdown.
 */
interface QueryClassECE {
  /** The query class. */
  readonly queryClass: QueryClass;

  /** ECE computed over cases of this query class. */
  readonly ece: number;

  /** Number of cases in this class. */
  readonly caseCount: number;
}

/**
 * Evaluates calibration quality of the engine's confidence scores,
 * per RFC-009 §8.
 *
 * A well-calibrated engine produces confidence scores that match
 * empirical accuracy: when it says "90% confident", it should be
 * correct ~90% of the time.
 */
export class CalibrationEvaluator {
  /**
   * Computes the Expected Calibration Error (ECE) over a set of results.
   *
   * ECE = Σ (|B_i| / N) * |accuracy(B_i) - confidence(B_i)|
   *
   * where B_i are equal-width confidence bins, and accuracy is the
   * correct-resolve rate within each bin.
   *
   * @param results - Evaluation results with confidence scores.
   * @param bins - Number of confidence bins (default: 10).
   * @returns The ECE in [0, 1]. Lower is better.
   */
  computeECE(results: readonly EvalResult[], bins: number = 10): number {
    if (results.length === 0) return 0;

    const reliability = this.computeReliabilityDiagram(results, bins);
    const totalCount = results.length;

    let ece = 0;
    for (const bin of reliability) {
      if (bin.count === 0) continue;
      const weight = bin.count / totalCount;
      const gap = Math.abs(bin.avgAccuracy - bin.avgConfidence);
      ece += weight * gap;
    }

    return ece;
  }

  /**
   * Computes a reliability diagram: for each confidence bin, reports
   * the average confidence and average accuracy.
   *
   * @param results - Evaluation results with confidence scores.
   * @param bins - Number of confidence bins (default: 10).
   * @returns Array of reliability bins from low to high confidence.
   */
  computeReliabilityDiagram(
    results: readonly EvalResult[],
    bins: number = 10,
  ): readonly ReliabilityBin[] {
    const binWidth = 1.0 / bins;
    const binData: { confidenceSum: number; correctCount: number; count: number }[] =
      Array.from({ length: bins }, () => ({
        confidenceSum: 0,
        correctCount: 0,
        count: 0,
      }));

    for (const result of results) {
      const binIndex = Math.min(
        Math.floor(result.decisionConfidence / binWidth),
        bins - 1,
      );
      const bin = binData[binIndex]!;
      bin.confidenceSum += result.decisionConfidence;
      bin.count += 1;
      if (result.isCorrectResolve) {
        bin.correctCount += 1;
      }
    }

    return binData.map((bin, i) => ({
      binCenter: (i + RELIABILITY_BIN_CENTER_OFFSET) * binWidth,
      avgConfidence: bin.count > 0 ? bin.confidenceSum / bin.count : (i + RELIABILITY_BIN_CENTER_OFFSET) * binWidth,
      avgAccuracy: bin.count > 0 ? bin.correctCount / bin.count : 0,
      count: bin.count,
    }));
  }

  /**
   * Computes ECE broken down by query class, using eval cases
   * to determine each result's query class.
   *
   * @param results - Evaluation results.
   * @param cases - Corresponding evaluation cases (matched by caseId).
   * @param bins - Number of confidence bins (default: 10).
   * @returns Per-query-class ECE values.
   */
  computePerQueryClassECE(
    results: readonly EvalResult[],
    cases: readonly EvalCase[],
    bins: number = 10,
  ): readonly QueryClassECE[] {
    const caseMap = new Map(cases.map((c) => [c.caseId, c]));

    // Group results by query class
    const grouped = new Map<QueryClass, EvalResult[]>();
    for (const result of results) {
      const evalCase = caseMap.get(result.caseId);
      if (!evalCase) continue;

      const existing = grouped.get(evalCase.queryClass);
      if (existing) {
        existing.push(result);
      } else {
        grouped.set(evalCase.queryClass, [result]);
      }
    }

    const perClass: QueryClassECE[] = [];
    for (const [queryClass, classResults] of grouped) {
      perClass.push({
        queryClass,
        ece: this.computeECE(classResults, bins),
        caseCount: classResults.length,
      });
    }

    return perClass;
  }
}
