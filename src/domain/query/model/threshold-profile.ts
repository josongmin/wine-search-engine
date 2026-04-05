import type { QueryClass } from '../../shared/types/index.js';

/**
 * A single threshold entry within a threshold profile.
 *
 * - `resolveTau` -- T_resolve(Q): minimum confidence to consider a candidate resolved.
 * - `gapTau` -- T_gap(Q): minimum gap between top-1 and top-2 confidence to avoid ambiguity.
 */
export interface ThresholdEntry {
  /** Resolution threshold T_resolve(Q) in [0, 1]. */
  readonly resolveTau: number;

  /** Gap threshold T_gap(Q) in [0, 1]. */
  readonly gapTau: number;
}

/**
 * Version 1 of the threshold profile -- the SSOT for per-query-class
 * resolution and gap thresholds.
 */
export interface ThresholdProfileV1 {
  /** Unique identifier for this profile. */
  readonly id: string;

  /** Semantic version string of this profile definition. */
  readonly version: string;

  /** Thresholds keyed by query class. */
  readonly perQueryClass: Readonly<Record<QueryClass, ThresholdEntry>>;

  /** Default penalty applied to confidence when ambiguity is detected, in [0, 1]. */
  readonly ambiguityPenaltyDefault: number;

  /** Optional reference to a separate abstention policy document. */
  readonly abstentionPolicyRef?: string | undefined;
}

/**
 * Default threshold profile — tuned to balance resolve coverage vs wrong-top-1.
 *
 * Previous profile (v1.0.0) was too conservative: combined with conformal
 * alpha=0.1, it caused 96% avoidable abstention. After relaxing alpha to 0.3
 * (conformal gate at C ≥ 0.7), the T_resolve values below become the actual
 * bottleneck.
 *
 * Principle (RFC-009): wrong resolve is -1.5 utility, avoidable abstain is -0.3.
 * A threshold is too high if it causes 5+ avoidable abstains per wrong resolve
 * it prevents (breakeven: 1.5 / 0.3 = 5).
 *
 * These values should be tuned on the gate eval set via AURC (RFC-009 §5.3).
 */
export const DEFAULT_THRESHOLD_PROFILE: ThresholdProfileV1 = {
  id: 'default-v2',
  version: '2.0.0',
  perQueryClass: {
    short_entity: { resolveTau: 0.60, gapTau: 0.10 },
    ambiguous_short_form: { resolveTau: 0.75, gapTau: 0.20 },
    anchored_similarity: { resolveTau: 0.55, gapTau: 0.08 },
    pure_constraint: { resolveTau: 0.50, gapTau: 0.08 },
    semantic_preference: { resolveTau: 0.45, gapTau: 0.05 },
    comparison_query: { resolveTau: 0.65, gapTau: 0.15 },
    unknown: { resolveTau: 0.65, gapTau: 0.15 },
  },
  ambiguityPenaltyDefault: 0.10,
} as const;
