/**
 * Calibrated resolution scores produced by the {@link Calibrator} service,
 * per RFC-006 §6.
 *
 * These scores are the ONLY inputs the decision layer may use for numeric
 * thresholding. Raw scores are explicitly forbidden from influencing decisions.
 */
export interface CalibratedResolutionScore {
  /** Calibrated probability for the top-1 candidate in [0, 1]. */
  readonly top1CalibratedScore: number;

  /** Calibrated probability for the top-2 candidate in [0, 1]. */
  readonly top2CalibratedScore: number;

  /** Gap between top-1 and top-2: delta = top1 - top2. Always >= 0. */
  readonly calibratedGap: number;

  /**
   * THE calibrated decision confidence C in [0, 1].
   * This is the sole numeric signal that the decision layer's threshold
   * comparison may reference. Derived from the calibrated top-1 score.
   */
  readonly decisionConfidenceC: number;
}
