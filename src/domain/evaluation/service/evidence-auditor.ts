import type { EvalResult } from '../model/eval-result.js';

/** Min summed positive evidence contribution for "sufficient" high-strength cases. */
const EVIDENCE_SUFFICIENCY_CONTRIBUTION_FLOOR = 0.3;
/** Evidence must explain at least this fraction of decision confidence. */
const EVIDENCE_COMPREHENSIVENESS_CONFIDENCE_RATIO = 0.5;

/**
 * Summary of evidence faithfulness metrics for a set of evaluation results.
 */
export interface EvidenceAuditSummary {
  /** Fraction of resolved cases where evidence alone produces the same decision. */
  readonly sufficiency: number;

  /** Fraction of resolved cases where removing evidence changes the decision. */
  readonly comprehensiveness: number;

  /** Fraction of all resolved cases with at least one evidence item. */
  readonly completenessRate: number;

  /** Total number of resolved cases audited. */
  readonly resolvedCaseCount: number;
}

/**
 * Audits evidence quality and faithfulness for evaluation results,
 * per RFC-009 §9.
 *
 * Evidence faithfulness has two dimensions:
 * - **Sufficiency**: the evidence alone is enough to justify the decision.
 *   Measured as the fraction of cases where presenting only the evidence
 *   items would lead to the same resolution.
 * - **Comprehensiveness**: the evidence is necessary for the decision.
 *   Measured as the fraction of cases where removing the evidence would
 *   change the resolution.
 */
export class EvidenceAuditor {
  /**
   * Computes evidence sufficiency across resolved results.
   *
   * Sufficiency measures whether the evidence trail alone could produce
   * the same decision. A result is considered "sufficient" if it has
   * at least one high-strength evidence item AND the total positive
   * contribution exceeds a minimum threshold.
   *
   * @param results - Evaluation results to audit.
   * @returns Sufficiency rate in [0, 1].
   */
  computeSufficiency(results: readonly EvalResult[]): number {
    const resolved = results.filter((r) => r.predictedStatus === 'resolved');
    if (resolved.length === 0) return 0;

    let sufficientCount = 0;

    for (const result of resolved) {
      if (result.evidenceItems.length === 0) continue;

      // Check for at least one high-strength evidence item
      const hasHighStrength = result.evidenceItems.some(
        (e) => e.strength === 'high',
      );

      // Sum positive contributions (evidence supporting the decision)
      const totalPositiveContribution = result.evidenceItems.reduce(
        (sum, e) => {
          const contribution = parseFloat(e.contribution);
          // isFinite rejects both NaN AND Infinity (parseFloat("1e308") → Infinity
          // would corrupt the sum and downstream ratio checks).
          return Number.isFinite(contribution) && contribution > 0 ? sum + contribution : sum;
        },
        0,
      );

      // Sufficiency requires strong evidence that collectively supports the decision
      if (hasHighStrength && totalPositiveContribution > EVIDENCE_SUFFICIENCY_CONTRIBUTION_FLOOR) {
        sufficientCount++;
      }
    }

    return sufficientCount / resolved.length;
  }

  /**
   * Computes evidence comprehensiveness across resolved results.
   *
   * Comprehensiveness measures whether removing the evidence would change
   * the decision. A result is "comprehensive" if the combined evidence
   * contribution is a significant portion of the overall confidence,
   * meaning its removal would likely alter the outcome.
   *
   * @param results - Evaluation results to audit.
   * @returns Comprehensiveness rate in [0, 1].
   */
  computeComprehensiveness(results: readonly EvalResult[]): number {
    const resolved = results.filter((r) => r.predictedStatus === 'resolved');
    if (resolved.length === 0) return 0;

    let comprehensiveCount = 0;

    for (const result of resolved) {
      if (result.evidenceItems.length === 0) continue;

      // Compute total absolute contribution of evidence
      const totalContribution = result.evidenceItems.reduce(
        (sum, e) => {
          const raw = parseFloat(e.contribution);
          // isFinite rejects NaN AND Infinity — a single Infinity contribution
          // would make totalContribution Infinity, corrupting the ratio at L115.
          const contribution = Number.isFinite(raw) ? Math.abs(raw) : 0;
          return sum + contribution;
        },
        0,
      );

      // Evidence is comprehensive if it accounts for a meaningful portion
      // of the decision confidence — removing it would drop confidence
      // below the resolve threshold.
      if (
        result.decisionConfidence > 0 &&
        totalContribution / result.decisionConfidence > EVIDENCE_COMPREHENSIVENESS_CONFIDENCE_RATIO
      ) {
        comprehensiveCount++;
      }
    }

    return comprehensiveCount / resolved.length;
  }

  /**
   * Computes the fraction of resolved cases with non-empty evidence trails.
   *
   * Every resolved decision must have an evidence trail per RFC-000 §9.1.
   * This metric flags cases where the obligation was violated.
   *
   * @param results - Evaluation results to audit.
   * @returns Completeness rate in [0, 1].
   */
  computeEvidenceCompletenessRate(results: readonly EvalResult[]): number {
    const resolved = results.filter((r) => r.predictedStatus === 'resolved');
    if (resolved.length === 0) return 0;

    const withEvidence = resolved.filter(
      (r) => r.evidenceItems.length > 0,
    ).length;

    return withEvidence / resolved.length;
  }

  /**
   * Runs a full evidence audit and returns a summary.
   *
   * @param results - Evaluation results to audit.
   * @returns Complete evidence audit summary.
   */
  audit(results: readonly EvalResult[]): EvidenceAuditSummary {
    return {
      sufficiency: this.computeSufficiency(results),
      comprehensiveness: this.computeComprehensiveness(results),
      completenessRate: this.computeEvidenceCompletenessRate(results),
      resolvedCaseCount: results.filter((r) => r.predictedStatus === 'resolved').length,
    };
  }
}
