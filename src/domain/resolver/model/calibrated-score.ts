/**
 * Calibrated resolution scores produced by the {@link Calibrator} service,
 * per RFC-006 §6.
 *
 * These scores are the ONLY inputs the decision layer may use for numeric
 * thresholding. Raw scores are explicitly forbidden from influencing decisions.
 *
 * C2 (fail-loud): runner-up absence is structurally distinct from "runner-up
 * scored 0". When there is no second candidate, `top2CalibratedScore` is
 * `undefined` and `calibratedGap` is `undefined`. Callers must branch on
 * `hasRunnerUp` before reading the gap; silent `0` fallback is forbidden.
 */
export interface CalibratedResolutionScore {
  /** Calibrated probability for the top-1 candidate in [0, 1]. */
  readonly top1CalibratedScore: number;

  /** Whether a runner-up candidate exists at all. Singleton → false. */
  readonly hasRunnerUp: boolean;

  /** Total number of candidates scored (>= 1). */
  readonly candidateCount: number;

  /**
   * Calibrated probability for the top-2 candidate in [0, 1].
   * `undefined` when no runner-up exists. Never 0 as a stand-in for absence.
   */
  readonly top2CalibratedScore: number | undefined;

  /**
   * Gap between top-1 and top-2: delta = top1 - top2 (always >= 0).
   * `undefined` when no runner-up exists — the gap is not meaningful for a
   * singleton candidate and decision logic must branch on `hasRunnerUp`.
   */
  readonly calibratedGap: number | undefined;

  /**
   * THE calibrated decision confidence C in [0, 1].
   * This is the sole numeric signal that the decision layer's threshold
   * comparison may reference. Derived from the calibrated top-1 score.
   */
  readonly decisionConfidenceC: number;

  /**
   * Whether the calibration applied to produce `decisionConfidenceC` used
   * trained parameters that were both loaded from the {@link CalibrationStore}
   * AND fresh enough to trust (P0.1 nightly auto-pipeline TTL gate), or fell
   * back to the identity (uncalibrated) pass-through / a stale-or-never-fitted
   * model.
   *
   * Downstream gates that depend on calibrated probability semantics
   * (e.g. {@link ConfidenceRefusalPolicy} in the AdmissionGate, RFC-016 §3
   * Epic 17.3) MUST skip their thresholding when this is `false` —
   * otherwise an uncalibrated/stale raw score is treated as a probability,
   * which violates RFC-006 §6 ("raw scores must never influence
   * decisions") and produces miscalibrated refusals.
   */
  readonly calibrationTrusted: boolean;
}
