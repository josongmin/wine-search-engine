/**
 * Confidence-based refusal mechanism for hallucination prevention (Epic 17.3).
 *
 * This policy rejects resolved decisions where the calibrated decision confidence
 * C falls below a configured threshold. The threshold is calibrated via ROC analysis
 * of wrong_top1 cases to catch hallucinations while minimizing false refusals.
 *
 * Reference: RFC-016 §3 (AdmissionGate), Epic 17.3 (Hallucination Verify)
 */

/**
 * ConfidenceRefusalPolicy: Rejects low-confidence decisions.
 *
 * The threshold is AURC-calibrated to operate at a specific point on the ROC curve:
 * - refusal_rate >= 0.90 when C < threshold (catch most hallucinations)
 * - false_refusal_rate <= 0.05 when C >= threshold (don't block good searches)
 *
 * By default, threshold = 0.45 (AURC-calibrated operating point).
 * Override via CONFIDENCE_REFUSAL_THRESHOLD environment variable.
 */
export class ConfidenceRefusalPolicy {
  /**
   * Creates a new ConfidenceRefusalPolicy.
   *
   * @param threshold - Confidence threshold (0 <= threshold <= 1).
   *   Default: 0.45 (AURC-calibrated).
   *   Decision is refused if C < threshold.
   */
  constructor(private readonly threshold: number = 0.45) {
    if (threshold < 0 || threshold > 1) {
      throw new Error(`Confidence threshold must be in [0, 1], got ${threshold}`);
    }
  }

  /**
   * Determines whether a decision should be refused due to low confidence.
   *
   * @param decisionConfidenceC - The resolver's calibrated decision confidence C.
   *   Must be in [0, 1].
   * @returns true if C < threshold (refusal recommended), false otherwise.
   */
  shouldRefuse(decisionConfidenceC: number): boolean {
    return decisionConfidenceC < this.threshold;
  }

  /**
   * Returns the configured threshold for diagnostic/logging purposes.
   */
  getThreshold(): number {
    return this.threshold;
  }
}
