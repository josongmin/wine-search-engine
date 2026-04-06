import type { DecisionSnapshot } from '../../shared/types/index.js';
import type { DecisionInput } from '../model/decision-input.js';
import type { FailureReason } from '../model/failure-reason.js';
import type { ConfidenceRefusalPolicy } from './confidence-refusal.js';

/**
 * Result of the AdmissionGate closure check (RFC-016).
 *
 * The gate is applied immediately before a resolved status is emitted.
 * - `{ admitted: true }` — the decision may proceed.
 * - `{ admitted: false, reason, traceRef }` — the decision is rejected with
 *   a machine-readable reason and a trace reference for audit trails.
 */
export type AdmissionResult =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      readonly reason: FailureReason;
      readonly traceRef: string;
    };

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
  check(input: DecisionInput, snapshot: DecisionSnapshot): AdmissionResult {
    const admissionContext = input.admissionContext
      ?? input.queryPlan.admission_context
      ?? {
        requires_identity_seal:
          input.queryPlan.intent === 'entity_exact' ||
          input.queryPlan.intent === 'entity_fuzzy' ||
          input.queryPlan.intent === 'comparison_search' ||
          input.queryPlan.intent === 'mixed_query' ||
          (input.effectiveRoute ?? input.queryPlan.route) === 'mixed',
        requires_constraint_evidence: input.queryPlan.constraints.hard.length > 0,
        requires_anchor_evidence:
          (input.effectiveRoute ?? input.queryPlan.route) === 'mixed' &&
          input.queryPlan.anchors.length > 0,
      };

    // ── (a) Identity-signature consistency ──────────────────────────────────
    //
    // The resolved top entity must be present and its entityId must be a
    // non-empty string.  An absent topEntity while the engine believes the
    // decision is resolved is an internal inconsistency.
    const topEntity = input.resolverResult.topEntity;
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
    // A resolved decision must be backed by identity evidence.  The boolean
    // `identityEvidencePresent` is the canonical signal set by the EvidenceGate
    // earlier in the pipeline.  If the summary is absent or the flag is false,
    // the decision lacks substantiation.
    if (!input.evidenceSummary?.identityEvidencePresent) {
      return this.reject('EVIDENCE_INSUFFICIENT', input, snapshot);
    }

    // ── (c) Hard-constraint compliance ───────────────────────────────────────
    //
    // When hard constraints are present in the query plan, constraint evidence
    // must have been gathered.  Absence of constraint evidence while hard
    // constraints exist means the entity was admitted without verifying
    // compliance with mandatory filters.
    const hasHardConstraints = input.queryPlan.constraints.hard.length > 0;
    if (hasHardConstraints && input.evidenceSummary.constraintEvidencePresent !== true) {
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
    if (admissionContext?.requires_anchor_evidence === true) {
      if (input.evidenceSummary.anchorEvidencePresent !== true) {
        return this.reject('EVIDENCE_INSUFFICIENT', input, snapshot);
      }

      // When the full evidence trail is available (populated by the ranking
      // stage), verify that at least one item is an anchor-type signal
      // (RFC-011 §11).  When evidenceItems is absent (entity-only route or
      // pre-ranking paths), the coarse anchorEvidencePresent flag above suffices.
      if (input.evidenceItems !== undefined) {
        // Only 'anchor_similarity' is produced by EvidenceMapper in production.
        // 'anchor_match' and 'anchor_preserved' were dead code paths — removed.
        const hasAnchorSignal = input.evidenceItems.some(
          (item) => item.type === 'anchor_similarity',
        );
        if (!hasAnchorSignal) {
          return this.reject('EVIDENCE_INSUFFICIENT', input, snapshot);
        }
      }
    }

    // ── (e) Confidence sufficiency (Epic 17.3, RFC-016 §3) ──────────────────────
    //
    // When a ConfidenceRefusalPolicy is provided (opt-in via env var), check that
    // the resolver's calibrated decision confidence C meets the minimum threshold.
    // This guards against hallucinations by refusing low-confidence resolved
    // decisions.
    //
    // The policy is OPTIONAL: if not provided, this check is skipped entirely
    // (backward compatible).
    if (this.confidenceRefusalPolicy !== undefined) {
      const C = input.resolverResult.decisionConfidenceC ?? 1.0;
      if (this.confidenceRefusalPolicy.shouldRefuse(C)) {
        return this.reject('CONFIDENCE_BELOW_THRESHOLD', input, snapshot);
      }
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
    const traceRef = `admission:${input.queryPlan.queryClass}:${snapshot.threshold_profile_id}:${String(Date.now())}`;
    return { admitted: false, reason, traceRef };
  }
}
