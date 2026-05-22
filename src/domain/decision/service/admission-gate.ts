import type { DecisionSnapshot } from '../../shared/types/index.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';
import {
  type AdmissionClosureSummary,
  type DecisionInput,
} from '../model/decision-input.js';
import type { FailureReason } from '../model/failure-reason.js';
import type { ConfidenceRefusalPolicy } from './confidence-refusal.js';
import { buildAdmissionAuthorityTraceRef } from './authority-trace.js';
import { decideAdmission } from './admission-policy.js';

/**
 * Result of the AdmissionGate closure check (RFC-016).
 *
 * The gate is applied immediately before a resolved status is emitted.
 * - `{ admitted: true }` — the decision may proceed.
 * - `{ admitted: false, reason, traceRef }` — the decision is rejected with
 *   a machine-readable reason and a trace reference for audit trails.
 */
type AdmissionResult =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: FailureReason;
      readonly traceRef: string;
    };

function deriveAdmissionContext(
  input: DecisionInput,
): {
  readonly requires_identity_seal: boolean;
  readonly requires_constraint_evidence: boolean;
  readonly requires_anchor_evidence: boolean;
} {
  return {
    requires_identity_seal: input.provenanceContract.policy.requireIdentitySeal,
    requires_constraint_evidence: input.provenanceContract.policy.requireConstraintEvidence,
    requires_anchor_evidence: input.provenanceContract.policy.requireAnchorEvidence,
  };
}

function hasAnchorSignalEvidence(input: DecisionInput): boolean {
  if (input.evidenceItems === undefined) {
    return true;
  }

  return input.evidenceItems.some((item) => item.type === 'anchor_similarity');
}

export function evaluateAdmissionClosure(
  input: DecisionInput,
  snapshot: DecisionSnapshot,
): AdmissionClosureSummary {
  const admissionContext = deriveAdmissionContext(input);
  const topEntity = input.resolveResult.topEntity;
  // Identity seal is required only when the planner / executionContext says
  // it is. For list-shaped queries (preference / similar_items / recommendation)
  // there is no winning entity whose identity could be sealed — the planner
  // emits `requires_identity_seal: false` and the closure must honor that or
  // every recommendation query rejects with EVIDENCE_INSUFFICIENT. The
  // `constraintEvidence` and `anchorEvidence` rows below already follow
  // this `!required || satisfied` pattern; we make identitySeal consistent.
  const identitySealRequired = admissionContext.requires_identity_seal;
  const identitySealEvidence =
    topEntity !== undefined &&
    String(topEntity.entityId).trim().length > 0 &&
    snapshot.threshold_profile_id === input.queryPlan.thresholdProfileId &&
    snapshot.policy_rule_version === input.queryPlan.policyRuleVersion &&
    snapshot.planner_version === input.queryPlan.plannerVersion &&
    input.provenanceContract.observed.identityEvidenceSatisfied;
  const identitySealSatisfied = !identitySealRequired || identitySealEvidence;
  const constraintEvidenceSatisfied =
    !admissionContext.requires_constraint_evidence ||
    input.provenanceContract.observed.constraintEvidenceSatisfied;
  const anchorEvidenceSatisfied =
    !admissionContext.requires_anchor_evidence ||
    (input.provenanceContract.observed.anchorEvidenceSatisfied && hasAnchorSignalEvidence(input));

  return {
    required: {
      identitySeal: identitySealRequired,
      constraintEvidence: admissionContext.requires_constraint_evidence,
      anchorEvidence: admissionContext.requires_anchor_evidence,
    },
    satisfied: {
      identitySeal: identitySealSatisfied,
      constraintEvidence: constraintEvidenceSatisfied,
      anchorEvidence: anchorEvidenceSatisfied,
    },
    allSatisfied:
      identitySealSatisfied &&
      constraintEvidenceSatisfied &&
      anchorEvidenceSatisfied,
  };
}

/**
 * THE FINAL CLOSURE — the AdmissionGate, per RFC-016.
 *
 * The AdmissionGate is the last invariant check before a resolved status is
 * emitted to downstream consumers. It guards against three classes of
 * violations that prior pipeline stages cannot prevent in isolation:
 *
 * (a) **Identity-signature consistency** — the resolved entity's identity
 *     references must be present and internally consistent with the snapshot
 *     that was active at decision time.
 *
 * (b) **Evidence sufficiency** — the evidence trail must meet the minimum
 *     evidence-reference count required for a binding resolution.
 *
 * (c) **Hard-constraint compliance** — every hard constraint from the query
 *     plan must be represented in the evidence trail (constraint evidence
 *     must be present when hard constraints exist).
 *
 * (d) **Confidence sufficiency (Epic 17.3)** — when enabled, the resolver's
 *     calibrated decision confidence C must meet a minimum threshold to guard
 *     against hallucinations. This check is OPTIONAL and only enabled when
 *     a ConfidenceRefusalPolicy is injected.
 *
 * Only resolved decisions are subject to all checks. Non-resolved decisions
 * pass through immediately so that the gate never blocks clarification or
 * failure outcomes.
 *
 * Backward compatibility: If no ConfidenceRefusalPolicy is provided, confidence
 * check (d) is skipped entirely.
 */
export class AdmissionGate {
  /**
   * Creates a new AdmissionGate.
   *
   * @param confidenceRefusalPolicy - Optional policy for confidence-based refusal
   *   (Epic 17.3). If provided, enables check (d) above.
   *   If absent, confidence check is skipped (backward compatible).
   */
  constructor(private readonly confidenceRefusalPolicy?: ConfidenceRefusalPolicy) {}

  /**
   * Evaluates admission for a resolved decision.
   *
   * @param input - The full decision input, providing identity references,
   *   evidence summary, hard constraints, and resolver confidence.
   * @param snapshot - The system-version snapshot active at decision time,
   *   used for identity-signature consistency checks.
   * @returns An {@link AdmissionResult} indicating whether the decision is
   *   admitted or rejected with a specific {@link FailureReason}.
  */
  async check(input: DecisionInput, snapshot: DecisionSnapshot): Promise<AdmissionResult> {
    const admissionContext = deriveAdmissionContext(input);
    const admissionClosure = evaluateAdmissionClosure(input, snapshot);

    // ── (a) Identity-signature consistency ──────────────────────────────────
    //
    // The resolved top entity must be present and its entityId must be a
    // non-empty string.  An absent topEntity while the engine believes the
    // decision is resolved is an internal inconsistency.
    const topEntity = input.resolveResult.topEntity;
    if (topEntity === undefined) {
      return this.reject('IDENTITY_REFERENCE_MISSING', input, snapshot);
    }

    if (!topEntity.entityId || String(topEntity.entityId).trim() === '') {
      return this.reject('IDENTITY_REFERENCE_MISSING', input, snapshot);
    }

    // Snapshot seal: the snapshot's threshold_profile_id must match the
    // thresholdProfileId recorded in the query plan.  A mismatch means the
    // decision was evaluated against a different configuration than the one
    // currently active — a snapshot consistency violation.
    if (snapshot.threshold_profile_id !== input.queryPlan.thresholdProfileId) {
      return this.reject('SNAPSHOT_MISMATCH', input, snapshot);
    }

    // Policy-rule seal: if the snapshot carries a policy_rule_version it must
    // be consistent with the plan's policyRuleVersion.
    if (snapshot.policy_rule_version !== input.queryPlan.policyRuleVersion) {
      return this.reject('IDENTITY_SEAL_VIOLATION', input, snapshot);
    }

    // Planner-version seal (RFC-016 §4): snapshot.planner_version must match
    // the version recorded in the query plan.  A mismatch means the decision
    // was evaluated against a different planner configuration.
    if (snapshot.planner_version !== input.queryPlan.plannerVersion) {
      return this.reject('SNAPSHOT_MISMATCH', input, snapshot);
    }

    // ── (b) Evidence sufficiency ─────────────────────────────────────────────
    //
    // A resolved decision must be backed by identity evidence. When richer
    // evidence detail is present, hasIdentityEvidence() evaluates that trail
    // instead of trusting the coarse boolean alone, so ranked-route drift
    // cannot silently admit a weak identity claim.
    if (!admissionClosure.satisfied.identitySeal) {
      return this.reject('EVIDENCE_INSUFFICIENT', input, snapshot);
    }

    // ── (c) Hard-constraint compliance ───────────────────────────────────────
    //
    // Constraint obligations follow the effective admission context rather
    // than raw plan shape alone. This keeps ranked-route and hybrid-route
    // flows aligned when orchestration explicitly relaxes or requires
    // constraint evidence for a specific execution path.
    if (!admissionClosure.satisfied.constraintEvidence) {
      return this.reject('HARD_CONSTRAINT_VIOLATION', input, snapshot);
    }

    // ── (d) Anchor evidence (RFC-016 §5, RFC-011 §11) ────────────────────────
    //
    // When admission_context signals that anchor evidence is required (mixed
    // route with anchors):
    //   1. The coarse `anchorEvidencePresent` flag must be true.
    //   2. The evidence_items trail must contain at least one item whose
    //      `type` is an anchor signal ('anchor_similarity', 'anchor_match',
    //      or 'anchor_preserved') — the boolean flag alone is not sufficient;
    //      the trail must be substantiated (RFC-011 §11).
    if (admissionContext.requires_anchor_evidence) {
      if (!admissionClosure.satisfied.anchorEvidence) {
        return this.reject('EVIDENCE_INSUFFICIENT', input, snapshot);
      }
    }

    // ── (e) Confidence sufficiency (Epic 17.3, RFC-016 §3) ──────────────────────
    //
    // When a ConfidenceRefusalPolicy is provided, check that the resolver's
    // calibrated decision confidence C meets the minimum threshold. This
    // guards against hallucinations by refusing low-confidence resolved
    // decisions.
    //
    // CRITICAL: enforcement is skipped when `calibrationTrusted` is false —
    // the resolver flags this when the Calibrator fell back to identity
    // pass-through because no trained calibration params exist for the
    // query class (RFC-006 §6). Treating an uncalibrated raw score as a
    // probability and refusing it against a fixed threshold would convert
    // the hallucination guard into a quasi-random gate on raw scoring,
    // producing high false-refusal rates immediately after deployment and
    // before the calibration ETL has populated the params table.
    // Operators see the silent-skip counter rise so the missing-calibration
    // condition is observable instead of silently neutering the guard.
    if (this.confidenceRefusalPolicy !== undefined) {
      // P0.1 trust gate (OUTER): when the calibrator emitted
      // `calibrationTrusted: false` (identity fallback, or stale/never-fitted
      // params per the nightly auto-pipeline TTL — see
      // PgCalibrationStore.loadIfFresh), the calibrated confidence is not a
      // reliable hallucination signal. Skip the refusal policy and raise the
      // silent-skip counter so the missing-calibration condition is observable
      // instead of silently neutering the guard.
      const trusted = input.resolveResult.decisionTrace.calibrationTrusted;
      if (!trusted) {
        globalSilentSkipCounter.increment('admission_gate_confidence_refusal_skipped_untrusted', {
          queryClass: input.queryPlan.queryClass,
        });
      } else {
        const C = input.resolveResult.decisionTrace.decisionConfidenceC;
        // P0.2 per-class threshold (INNER): when a PG-backed provider is wired
        // the async evaluator looks up the AURC-derived threshold for the
        // query class. Its own `calibrationTrusted` flag reflects provider
        // availability (DB outage / cold start) so an unavailable provider
        // degrades to "do not refuse" rather than being translated into a
        // silent refusal. Without a provider we fall back to the global floor.
        if (this.confidenceRefusalPolicy.hasProvider()) {
          const evaluation = await this.confidenceRefusalPolicy.evaluate(
            C,
            input.queryPlan.queryClass,
          );
          if (evaluation.calibrationTrusted && evaluation.shouldRefuse) {
            return this.reject('CONFIDENCE_BELOW_THRESHOLD', input, snapshot);
          }
        } else if (this.confidenceRefusalPolicy.shouldRefuse(C)) {
          return this.reject('CONFIDENCE_BELOW_THRESHOLD', input, snapshot);
        }
      }
    }

    // `evidenceSufficient` is the policy-conditional identity check: when
    // identity sealing is NOT required by admission_context (list-shaped
    // queries — `pairing_search`, `similar_items`, `recommendation`, …),
    // the strict identity-evidence presence is irrelevant — the resolved
    // verdict isn't claiming an identity. Without this gate, every
    // preference-mode resolved decision auto-rejects via the `clarify`
    // outcome at line ~300 (`!evidenceSufficient → clarify`), even when
    // the upstream EvidenceGate / CalibrationTrustGate explicitly let it
    // through. The same `!required || satisfied` pattern is already used
    // for `constraintEvidence` / `anchorEvidence` in
    // `evaluateAdmissionClosure`; we apply it here so `decideAdmission`
    // and the closure stay consistent.
    const evidenceSufficientForAdmission =
      !admissionContext.requires_identity_seal ||
      input.provenanceContract.observed.identityEvidenceSatisfied;
    const policyOutcome = decideAdmission({
      confidence: input.resolveResult.decisionTrace.decisionConfidenceC,
      evidenceSufficient: evidenceSufficientForAdmission,
      ambiguityHigh: input.ambiguitySummary?.severity === 'high',
      routeHealthy: input.routeHealthy ?? true,
      executionMode: input.executionMode ?? 'authoritative',
      ...(input.effectiveRetrievalMode !== undefined
        ? { effectiveRetrievalMode: input.effectiveRetrievalMode }
        : {}),
      ...(input.blockingRequested !== undefined
        ? { blockingRequested: input.blockingRequested }
        : {}),
    });
    if (policyOutcome === 'reject') {
      return this.reject('POLICY_BLOCKED', input, snapshot);
    }
    if (policyOutcome === 'clarify') {
      if (input.ambiguitySummary?.severity === 'high') {
        return this.reject('AMBIGUITY_BLOCKED', input, snapshot);
      }
      return this.reject('EVIDENCE_INSUFFICIENT', input, snapshot);
    }

    return { admitted: true };
  }

  /**
   * Builds a rejected {@link AdmissionResult} with a stable trace reference.
   *
   * The trace reference encodes the query class and rejection timestamp so
   * that the rejection event can be correlated with pipeline logs.
   */
  private reject(
    reason: FailureReason,
    input: DecisionInput,
    snapshot: DecisionSnapshot,
  ): AdmissionResult {
    if (input.effectiveRoute === undefined) {
      throw new Error('DecisionInput.effectiveRoute is required for compiled-only execution');
    }
    if (input.effectiveRetrievalMode === undefined) {
      throw new Error('DecisionInput.effectiveRetrievalMode is required for compiled-only execution');
    }
    const traceRef = buildAdmissionAuthorityTraceRef({
      queryPlan: input.queryPlan,
      snapshot,
      reason,
      route: input.effectiveRoute,
      retrievalMode: input.effectiveRetrievalMode,
      ...(input.retrievalKind !== undefined
        ? { retrievalKind: input.retrievalKind }
        : {}),
    });
    return { admitted: false, reason, traceRef };
  }
}
