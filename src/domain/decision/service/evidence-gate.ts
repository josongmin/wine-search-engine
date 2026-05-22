/**
 * E6-U2: Quality Gate Input Contract (lock)
 *
 * EvidenceGate is the SINGLE quality gate owner. Input fields it reads:
 *   - DecisionInput.provenanceContract.policy — compiled execution obligations
 *   - DecisionInput.provenanceContract.observed — observed evidence satisfaction
 *
 * Do NOT combine explanation policy (explanation-obligation.ts) with this
 * quality gate — they are separate concerns:
 *   - evidence-gate.ts: ENFORCES evidence presence (binary pass/fail)
 *   - explanation-obligation.ts: DECLARES what explanation SHOULD be shown
 *
 * Do NOT add scoring policy, threshold logic, or session signal reads here.
 */
import type { DecisionStatus, NextAction } from '../../shared/types/index.js';
import {
  type DecisionProvenanceContract,
} from '../model/decision-input.js';

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
 * E4-U4: Explanation-Policy Responsibility Split
 *
 * This module owns evidence obligation evaluation (RFC-007 §4.1).
 * Responsibility boundaries:
 *  - evidence-gate.ts (here) — evaluates WHAT evidence is required and whether it's present
 *  - response-builder.ts      — assembles the response (field population, no obligation logic)
 *  - interpret-explain-adapter-v2.ts — formats explanation text (no obligation decisions)
 *
 * Do NOT add evidence suppression / fallback logic to response-builder.
 * Do NOT add response formatting / field mapping here.
 */

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
   * @param provenanceContract - Compiled-first evidence closure contract.
   * @returns The gate result, including any downgrade directive.
   */
  check(
    decisionStatus: DecisionStatus,
    provenanceContract?: DecisionProvenanceContract,
  ): EvidenceGateResult {
    // Only resolved decisions are subject to evidence obligations.
    if (decisionStatus !== 'resolved') {
      return { passed: true };
    }

    if (provenanceContract === undefined) {
      return {
        passed: false,
        downgradeTo: 'ambiguous',
        downgradeAction: 'clarify',
        reason: 'EVIDENCE_GATE_NO_IDENTITY: resolved without provenance contract',
      };
    }

    // Rule 0: resolved + no concrete target → downgrade.
    //
    // A 'resolved' decision must point to *something* — either a resolved
    // entity (`topEntityPresent`) or a ranked search result
    // (`rankedTopResultPresent`). When BOTH are false there is no concrete
    // output for the user to act on, yet the calibrated C may still cross
    // the resolve threshold (e.g. an anchor extracted from a generic token
    // like 'wine' that the resolver could not bind to any entity, and which
    // the policy did not require an identity seal for, leaving Rule 1's
    // identity check vacuously satisfied via `!policy.requireIdentitySeal`).
    // The empty-target case was previously slipping through that vacuous
    // truth and emitting `resolved` for gibberish input.
    //
    // This rule runs BEFORE Rule 1 so the no-target condition is named
    // explicitly in `rulesApplied`, distinct from the no-identity case.
    if (
      !provenanceContract.observed.topEntityPresent &&
      !provenanceContract.observed.rankedTopResultPresent
    ) {
      return {
        passed: false,
        downgradeTo: 'ambiguous',
        downgradeAction: 'clarify',
        reason: 'EVIDENCE_GATE_NO_TARGET: resolved with no entity and no ranked result',
      };
    }

    // Rule 1: resolved + identity evidence REQUIRED but missing → downgrade.
    //
    // The check used to fire on `!identityEvidenceSatisfied` regardless of
    // whether identity sealing was actually required — but
    // `observed.identityEvidenceSatisfied` here is computed strictly (raw
    // evidence presence, not policy-conditional —
    // `search-usecase-decision-input.ts` line ~446) and would always be
    // false on a preference / recommendation route where there is no
    // resolved entity by design. Gating on `policy.requireIdentitySeal`
    // mirrors how `provenance-closure.ts` builds its OWN
    // `identityEvidenceSatisfied` (`!policy.requireIdentitySeal ||
    // hasIdentityEvidence`) and how the AdmissionGate keys its identity-
    // seal check on `admission_context.requires_identity_seal`. For list-
    // shaped queries (`pairing_search` / `similar_items` / etc.) the
    // planner emits `requires_identity_seal: false`; the gate now honors
    // that signal and lets the resolved verdict stand if the rest of the
    // obligation set passes.
    if (
      provenanceContract.policy.requireIdentitySeal &&
      !provenanceContract.observed.identityEvidenceSatisfied
    ) {
      return {
        passed: false,
        downgradeTo: 'ambiguous',
        downgradeAction: 'clarify',
        reason: 'EVIDENCE_GATE_NO_IDENTITY: resolved without identity evidence',
      };
    }

    // Rule 2: resolved + constraints present but no constraint evidence → downgrade
    if (
      provenanceContract.policy.requireConstraintEvidence &&
      !provenanceContract.observed.constraintEvidenceSatisfied
    ) {
      return {
        passed: false,
        downgradeTo: 'ambiguous',
        downgradeAction: 'clarify',
        reason: 'EVIDENCE_GATE_NO_CONSTRAINT: resolved with constraints but no constraint evidence',
      };
    }

    // Rule 3: anchor present but no anchor evidence → downgrade
    if (
      provenanceContract.policy.requireAnchorEvidence &&
      !provenanceContract.observed.anchorEvidenceSatisfied
    ) {
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
