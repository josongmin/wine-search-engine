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
 * Default threshold profile with conservative values.
 *
 * Higher thresholds for ambiguous / comparison queries where incorrect
 * resolution is costly; lower thresholds for pure-constraint and
 * semantic-preference queries where approximate results are acceptable.
 */
export const DEFAULT_THRESHOLD_PROFILE: ThresholdProfileV1 = {
  id: 'default-v1',
  version: '1.0.0',
  perQueryClass: {
    short_entity: { resolveTau: 0.75, gapTau: 0.15 },
    ambiguous_short_form: { resolveTau: 0.90, gapTau: 0.25 },
    anchored_similarity: { resolveTau: 0.70, gapTau: 0.10 },
    pure_constraint: { resolveTau: 0.65, gapTau: 0.10 },
    semantic_preference: { resolveTau: 0.60, gapTau: 0.08 },
    comparison_query: { resolveTau: 0.80, gapTau: 0.20 },
    unknown: { resolveTau: 0.85, gapTau: 0.20 },
  },
  ambiguityPenaltyDefault: 0.15,
} as const;
