/**
 * Split conformal prediction for retrieval confidence intervals.
 *
 * Reference: Vovk et al. 2005 "Algorithmic Learning in a Random World";
 * Angelopoulos & Bates 2021 "A Gentle Introduction to Conformal Prediction".
 *
 * Given a calibration set of (predicted_score, true_label) pairs and a
 * coverage level (e.g., 0.9 = 90% coverage), conformal prediction produces
 * a threshold tau such that any new prediction with score > tau is
 * "guaranteed" (with probability >= coverage) to be relevant.
 */
import { clamp } from '../../shared/utils/clamp.js';

/**
 * Sentinel tau when no calibration data is available.
 *
 * Set to `NaN` so that {@link applyConformal}'s acceptance check
 * (`nc < calibration.tau`) is **always false** (NaN comparisons return
 * false). This is fail-closed: an uncalibrated predictor cannot make
 * any confidence claim, so every score is rejected.
 *
 * We deliberately do NOT default to 0.5 (heuristic midpoint), 1 (every
 * point passes), or 0 (no points pass). NaN encodes "no decision boundary
 * defined" — the only honest answer when there is no calibration data.
 *
 * Callers that need to distinguish "uncalibrated" from "calibrated and
 * rejected" must check `calibrationSize === 0` explicitly, not the tau value.
 */
const UNCALIBRATED_TAU_SENTINEL = Number.NaN;
/** Default coverage levels. */
export const DEFAULT_COVERAGE_90 = 0.9;
export const DEFAULT_COVERAGE_95 = 0.95;
/** Valid bounds for coverage level. */
const MIN_COVERAGE_LEVEL = 0;
const MAX_COVERAGE_LEVEL = 1;

export interface ConformalCalibration {
  readonly coverageLevel: number;
  readonly tau: number;
  readonly calibrationSize: number;
}

interface ConformalScoreInterval {
  /** Predicted score. */
  readonly point: number;
  /** Whether the score exceeds the conformal threshold. */
  readonly aboveThreshold: boolean;
}

/**
 * Compute the nonconformity score for a (score, correct) pair.
 *
 * We want HIGH nonconformity to mean "likely wrong":
 *   - When correct=true: nonconformity = 1 - score (low score on correct = suspicious)
 *   - When correct=false: nonconformity = score (high score on wrong = suspicious)
 */
function nonconformity(score: number, correct: boolean): number {
  return correct ? 1 - score : score;
}

/**
 * Calibrate a split conformal predictor.
 *
 * Algorithm:
 *   1. Compute nonconformity scores for each calibration point.
 *   2. Sort ascending.
 *   3. tau = the ceil((1 - coverageLevel) * (n + 1))-th smallest nonconformity
 *      (equivalent to the (1 - coverageLevel) quantile of the augmented set).
 *
 * Note: the finite-sample conformal quantile uses (n+1) to account for the
 * exchangeability of the new test point with the calibration set.
 */
export function calibrateConformal(
  predictions: readonly { readonly score: number; readonly correct: boolean }[],
  coverageLevel: number,
): ConformalCalibration {
  // Coverage must be in (0, 1]. Exactly 0 is meaningless (covers nothing);
  // exactly 1.0 is valid (covers everything → tau = max nonconformity).
  const clampedCoverage =
    Number.isFinite(coverageLevel) &&
    coverageLevel > MIN_COVERAGE_LEVEL &&
    coverageLevel <= MAX_COVERAGE_LEVEL
      ? coverageLevel
      : DEFAULT_COVERAGE_90;

  const indexed: { nc: number; index: number }[] = [];
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i]!;
    if (!Number.isFinite(p.score)) continue;
    indexed.push({ nc: nonconformity(p.score, p.correct), index: i });
  }

  if (indexed.length === 0) {
    return {
      coverageLevel: clampedCoverage,
      tau: UNCALIBRATED_TAU_SENTINEL,
      calibrationSize: 0,
    };
  }

  // Stable ascending sort with index tiebreaker.
  indexed.sort((a, b) => {
    if (a.nc !== b.nc) return a.nc - b.nc;
    return a.index - b.index;
  });

  const n = indexed.length;
  // Finite-sample conformal quantile: ceil((1 - alpha) * (n + 1)) / n order stat.
  // Here "coverageLevel" means 1 - alpha, so alpha = 1 - coverageLevel.
  // We want the ceil((1 - alpha) * (n + 1)) = ceil(coverageLevel * (n + 1))
  // smallest nonconformity. If that rank exceeds n, fall back to the maximum.
  const rank = Math.ceil(clampedCoverage * (n + 1));
  const clampedRank = clamp(rank, 1, n);
  const tau = indexed[clampedRank - 1]!.nc;

  return {
    coverageLevel: clampedCoverage,
    tau,
    calibrationSize: n,
  };
}

/**
 * Apply a conformal calibration to a new score.
 *
 * The prediction is "above threshold" (accepted as sufficiently confident)
 * iff its nonconformity (1 - score) is strictly below the calibrated tau.
 */
export function applyConformal(
  score: number,
  calibration: ConformalCalibration,
): ConformalScoreInterval {
  if (!Number.isFinite(score)) {
    return { point: 0, aboveThreshold: false };
  }
  // Treat the new point as potentially correct: nc = 1 - score.
  const nc = 1 - score;
  return {
    point: score,
    aboveThreshold: nc < calibration.tau,
  };
}
