/**
 * Calibration suite — one-stop assessment combining AURC, ECE, Platt scaling,
 * split conformal prediction, and the AURC-gated threshold optimizer.
 *
 * Used by benchmark runs and admin tools to summarize calibration quality.
 *
 * Rule 33 status (2026-04-12): This module is intentionally eval-only, not
 * wired into the production request path. It is imported by:
 *   - scripts/eval/calibration-report.ts (calibration benchmark runner)
 *
 * The production decision-confidence path uses the request-path threshold
 * optimizer. This calibration-
 * domain variant provides richer offline metrics (AURC, ECE, Platt, conformal)
 * that are too expensive for the request path but valuable for eval dashboards.
 *
 * If this module grows into a production concern, wire via
 * src/config/container-aux-features.ts and remove this comment.
 */

import { computeAURC, type AURCResult } from './aurc.js';
import { computeECE, type ECEResult } from './ece.js';
import { fitPlattCalibrator, type PlattCalibrator } from './platt-scaling.js';
import {
  calibrateConformal,
  DEFAULT_COVERAGE_90,
  DEFAULT_COVERAGE_95,
  type ConformalCalibration,
} from './conformal-prediction.js';
import { findOptimalThreshold, type OptimalThreshold } from './threshold-optimizer.js';

/** Target risk levels for the optimal threshold report. */
const RISK_TARGET_5_PCT = 0.05;
const RISK_TARGET_10_PCT = 0.10;

export interface CalibrationReport {
  readonly aurc: AURCResult;
  readonly ece: ECEResult;
  readonly platt: PlattCalibrator;
  readonly conformal_90: ConformalCalibration;
  readonly conformal_95: ConformalCalibration;
  readonly optimal_threshold_5pct_risk: OptimalThreshold;
  readonly optimal_threshold_10pct_risk: OptimalThreshold;
  readonly sampleSize: number;
}

/**
 * Build a full calibration report from (score, correct) predictions.
 *
 * The AURC and ECE metrics expect a `confidence` field, while the Platt
 * calibrator, conformal predictor, and threshold optimizer expect `score`.
 * In this module we treat `score` as the confidence signal (both live in
 * [0,1] for calibrated retrieval scores).
 */
export function buildCalibrationReport(
  predictions: readonly { readonly score: number; readonly correct: boolean }[],
): CalibrationReport {
  const confidencePairs = predictions.map((p) => ({
    confidence: p.score,
    correct: p.correct,
  }));

  const aurc = computeAURC(confidencePairs);
  const ece = computeECE(confidencePairs);
  const platt = fitPlattCalibrator(predictions);
  const conformal_90 = calibrateConformal(predictions, DEFAULT_COVERAGE_90);
  const conformal_95 = calibrateConformal(predictions, DEFAULT_COVERAGE_95);
  const optimal_threshold_5pct_risk = findOptimalThreshold(predictions, {
    maxRisk: RISK_TARGET_5_PCT,
  });
  const optimal_threshold_10pct_risk = findOptimalThreshold(predictions, {
    maxRisk: RISK_TARGET_10_PCT,
  });

  return {
    aurc,
    ece,
    platt,
    conformal_90,
    conformal_95,
    optimal_threshold_5pct_risk,
    optimal_threshold_10pct_risk,
    sampleSize: predictions.length,
  };
}
