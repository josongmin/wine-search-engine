/**
 * E6: Typed Abstain/Clarify — machine-readable abstain decision types.
 *
 * Replaces the legacy untyped `reason?: string` pattern in AbstainDecision
 * with a 4-value enum that downstream consumers (response builder, search
 * usecase, EPIC-8 audit) can branch on deterministically.
 */

import type { ConstraintRelation } from '../service/constraint-reasoner.js';

// ─── AbstainReason ────────────────────────────────────────────────────────────

/**
 * Machine-readable reason for an abstain decision.
 *
 * | value                  | when                                                        |
 * |------------------------|-------------------------------------------------------------|
 * | `no_match`             | Hard filter left 0 candidates                              |
 * | `low_confidence`       | Candidates exist but top-K entropy ≥ threshold (uniform)   |
 * | `semantic_conflict`    | EPIC-2 ConstraintRelation soft_tension or contradiction     |
 * | `insufficient_evidence`| Dense + anchor channels both degraded; sparse-only result  |
 */
export type AbstainReason =
  | 'no_match'
  | 'low_confidence'
  | 'semantic_conflict'
  | 'insufficient_evidence';

// ─── RecoveryAction ───────────────────────────────────────────────────────────

/**
 * Suggested recovery action when abstain is true.
 * Consumed by the response layer to surface actionable guidance.
 */
export type RecoveryAction =
  | 'relax_constraints'
  | 'clarify'
  | 'retry_with_dense'
  | 'split_query';

// ─── TypedAbstainDecision ─────────────────────────────────────────────────────

/**
 * E6: Typed abstain decision — returned by the extended AbstainPolicy.evaluate()
 * when the engine should abstain from returning results.
 *
 * When `shouldAbstain` is false, no TypedAbstainDecision is produced.
 */
export interface TypedAbstainDecision {
  readonly shouldAbstain: true;

  /** Structured reason — consumers MUST branch on this, not on `detail`. */
  readonly reason: AbstainReason;

  /** Human-readable explanation for logging and API response. */
  readonly detail: string;

  /**
   * Suggested recovery path.
   * Absent when no recovery is possible (e.g. hard rule contradiction).
   */
  readonly recoverableBy?: RecoveryAction | undefined;

  /**
   * Constraint relations that triggered the abstain, when reason is
   * `semantic_conflict`. Populated from EPIC-2 ConstraintReasoner output.
   */
  readonly conflictingRelations?: readonly ConstraintRelation[] | undefined;

  /**
   * Normalized entropy value when reason is `low_confidence`.
   * Absent for other reasons. Used by the response builder to include
   * the entropy figure in trace logs and the entropy-abstain response path.
   */
  readonly entropy?: number | undefined;
}

// ─── ClarifyKind ─────────────────────────────────────────────────────────────

/**
 * E6: Structured clarification kind.
 *
 * | value                   | when                                                        |
 * |-------------------------|-------------------------------------------------------------|
 * | `anchor_disambiguation` | Multiple entity candidates match the anchor surface form    |
 * | `constraint_conflict`   | Soft tension detected — opposing constraints in query       |
 * | `preference_gap`        | Constraints present but result quality too low              |
 * | `budget_gap`            | Price + quality constraints cannot be jointly satisfied     |
 */
export type ClarifyKind =
  | 'anchor_disambiguation'
  | 'constraint_conflict'
  | 'preference_gap'
  | 'budget_gap';

// ─── StructuredClarifyPayload ─────────────────────────────────────────────────

/**
 * E6: Structured clarification payload.
 *
 * Replaces the generic `ClarificationPayload.reason: string` pattern.
 * The `kind` field lets the UI / response layer render kind-specific UI
 * (disambiguation list, conflict resolution, budget adjuster, etc.).
 */
export interface StructuredClarifyPayload {
  /** What type of clarification is needed. */
  readonly kind: ClarifyKind;

  /** Natural-language question to surface to the user. */
  readonly question: string;

  /**
   * Selectable options (present for anchor_disambiguation and budget_gap).
   * For anchor_disambiguation: entity labels. For budget_gap: relaxed ranges.
   */
  readonly options?: readonly string[] | undefined;

  /**
   * The two conflicting constraint attributes (present for constraint_conflict).
   * E.g. `['sweetness', 'dryness']`.
   */
  readonly conflictingAtoms?: readonly [string, string] | undefined;

  /**
   * Human-readable description of why constraints cannot be jointly satisfied
   * (present for budget_gap).
   */
  readonly gapDescription?: string | undefined;
}

// ─── ChannelDegradationSummary ────────────────────────────────────────────────

/**
 * Summary of channel degradation state fed into AbstainPolicy.evaluate().
 * Derived from EPIC-4 retrieval evidence (CandidateProvenanceDetail.degraded).
 */
export interface ChannelDegradationSummary {
  /** Whether the dense semantic channel is degraded. */
  readonly denseDegraded: boolean;
  /** Whether the anchor similarity channel is degraded. */
  readonly anchorDegraded: boolean;
  /** Whether the sparse BM25 channel is degraded. */
  readonly sparseDegraded: boolean;
}
