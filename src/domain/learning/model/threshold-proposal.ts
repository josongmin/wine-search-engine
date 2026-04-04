import type { QueryClass } from '../../shared/types/index.js';

/**
 * Status of a threshold proposal as it moves through the promotion pipeline.
 *
 * - `pending`        — proposed, awaiting shadow testing.
 * - `shadow_testing` — being tested in shadow mode (no production impact).
 * - `approved`       — shadow testing passed, ready for promotion.
 * - `rejected`       — rejected due to regression or policy violation.
 */
export type ThresholdProposalStatus = 'pending' | 'shadow_testing' | 'approved' | 'rejected';

/**
 * A set of decision threshold values for a query class.
 */
export interface ThresholdSet {
  /** Minimum calibrated confidence to resolve (T_resolve). */
  readonly tResolve: number;

  /** Minimum calibrated gap between top-1 and top-2 (T_gap). */
  readonly tGap: number;

  /** Confidence below which the engine should fail (T_fail). */
  readonly tFail: number;
}

/**
 * Evidence supporting a threshold change proposal.
 */
export interface ThresholdProposalEvidence {
  /** Number of evaluation cases used to compute the expected improvement. */
  readonly evalCaseCount: number;

  /** Decision Utility with the current thresholds. */
  readonly utilityBefore: number;

  /** Decision Utility with the proposed thresholds. */
  readonly utilityAfter: number;
}

/**
 * A proposed threshold adjustment from the learning loop, per RFC-010 §8.
 *
 * The threshold optimizer performs grid search over T_resolve, T_gap,
 * and T_fail values to maximize Decision Utility on a held-out eval set.
 * Proposals always start as 'pending' and must pass through shadow
 * testing before promotion.
 */
export interface ThresholdProposal {
  /** Unique identifier for this proposal. */
  readonly proposalId: string;

  /** The query class these thresholds apply to. */
  readonly queryClass: QueryClass;

  /** The proposed threshold values. */
  readonly proposedThresholds: ThresholdSet;

  /** The current threshold values being replaced. */
  readonly currentThresholds: ThresholdSet;

  /** Expected change in Decision Utility (positive = improvement). */
  readonly expectedUtilityDelta: number;

  /** Statistical evidence supporting this proposal. */
  readonly evidence: ThresholdProposalEvidence;

  /** Current status in the promotion pipeline. */
  readonly status: ThresholdProposalStatus;
}
