import type { DecisionStatus, NextAction } from '../../shared/types/index.js';
import type { EvidenceSummary } from '../model/decision-input.js';

/**
 * Result of the evidence obligation gate check.
 */
export interface EvidenceGateResult {
  /** Whether the evidence obligations are satisfied. */
  readonly passed: boolean;

  /** If not passed, the status to downgrade to. */
  readonly downgradeTo?: DecisionStatus;

  /** If not passed, the action to prescribe instead. */
  readonly downgradeAction?: NextAction;

  /** Human-readable reason for the downgrade. */
  readonly reason?: string;
}

/**
 * Implements the evidence obligation gate per RFC-007 §4.1.
 *
 * Every resolution decision must be backed by sufficient evidence.
 * If a candidate is "resolved" but lacks the required evidence trail,
 * the gate downgrades the decision to prevent unjustified resolutions.
 *
 * Evidence obligation rules:
 * 1. Resolved + no identity evidence => downgrade to AMBIGUOUS + clarify.
 * 2. Resolved + constraints present but no constraint evidence => downgrade.
 * 3. Anchor present but no anchor evidence => downgrade.
 */
export class EvidenceGate {
  /**
   * Checks whether the evidence obligations are met for a given decision status.
   *
   * @param decisionStatus - The proposed decision status to validate.
   * @param evidenceSummary - Summary of available evidence. If absent, all obligations fail.
   * @param hasConstraints - Whether the query has constraints that need evidence.
   * @param hasAnchor - Whether the query has an anchor entity that needs evidence.
   * @returns The gate result, including any downgrade directive.
   */
  check(
    decisionStatus: DecisionStatus,
    evidenceSummary?: EvidenceSummary,
    hasConstraints?: boolean,
    hasAnchor?: boolean,
  ): EvidenceGateResult {
    // Only resolved decisions are subject to evidence obligations.
    if (decisionStatus !== 'resolved') {
      return { passed: true };
    }

    // Rule 1: resolved + no identity evidence → downgrade
    if (!evidenceSummary?.identityEvidencePresent) {
      return {
        passed: false,
        downgradeTo: 'ambiguous',
        downgradeAction: 'clarify',
        reason: 'EVIDENCE_GATE_NO_IDENTITY: resolved without identity evidence',
      };
    }

    // Rule 2: resolved + constraints present but no constraint evidence → downgrade
    if (hasConstraints === true && evidenceSummary.constraintEvidencePresent !== true) {
      return {
        passed: false,
        downgradeTo: 'ambiguous',
        downgradeAction: 'clarify',
        reason: 'EVIDENCE_GATE_NO_CONSTRAINT: resolved with constraints but no constraint evidence',
      };
    }

    // Rule 3: anchor present but no anchor evidence → downgrade
    if (hasAnchor === true && evidenceSummary.anchorEvidencePresent !== true) {
      return {
        passed: false,
        downgradeTo: 'ambiguous',
        downgradeAction: 'clarify',
        reason: 'EVIDENCE_GATE_NO_ANCHOR: anchor present but no anchor evidence',
      };
    }

    return { passed: true };
  }
}
