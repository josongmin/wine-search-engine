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
 * Computes a dynamic gap threshold tailored to the query class and confidence level.
 * Per RFC-009 §5.3, thresholds must be tuned via AURC (Area Under the Risk-Coverage Curve).
 *
 * Query-class rationale:
 * - `semantic_preference`: Natural language preferences like "smooth and fruity".
 *   These queries inherently have fuzzy semantics. A tight gap (1.5%) is appropriate
 *   because the user is seeking the *best fit*, not exact identity.
 *   Lower threshold allows ranking disambiguation when confidence is reasonable.
 *
 * - `short_entity`: Direct lookups like "Opus One 2018".
 *   High confidence context; moderate gap (3%) balances early resolution with safety.
 *
 * - `entity_exact`, `ambiguous_short_form`, `comparison_query`: Require strict disambiguation.
 *   Wide gap (5-10%) to ensure clear winner when multiple candidates are plausible.
 *
 * - `anchored_similarity`, `pure_constraint`: Moderate complexity.
 *   Gap threshold of 3-5% based on signal strength.
 *
 * @param queryClass The classification of the incoming query
 * @param confidence The calibrated decision confidence C in [0, 1]
 * @returns The dynamic gap threshold T_gap(Q) in [0, 1]
 */
export function computeDynamicGapThreshold(
  queryClass: QueryClass,
  confidence: number,
): number {
  // Semantic preference: lowest gap required (1.5%), allows fuzzy matching
  if (queryClass === 'semantic_preference') {
    // If confidence > 0.55, even lower gap (1%) acceptable
    if (confidence > 0.55) {
      return 0.01;
    }
    // Standard semantic pref: 1.5%
    return 0.015;
  }

  // Short entity: moderate gap (3%)
  if (queryClass === 'short_entity') {
    return 0.03;
  }

  // Entity exact: highest precision required, widest gap (10%)
  // Ensures only truly dominant candidates resolve when explicit exact match is required
  if (queryClass === 'entity_exact') {
    return 0.10;
  }

  // Ambiguous short form: wider gap (8%)
  if (queryClass === 'ambiguous_short_form') {
    return 0.08;
  }

  // Anchored similarity: moderate gap (3%)
  if (queryClass === 'anchored_similarity') {
    return 0.03;
  }

  // Pure constraint: moderate-wide gap (5%)
  if (queryClass === 'pure_constraint') {
    return 0.05;
  }

  // Comparison query: wide gap (10%)
  if (queryClass === 'comparison_query') {
    return 0.10;
  }

  // Unknown: fallback to wide gap (10%)
  return 0.10;
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
 * Wave 3 (v2.1.0) enhancement (RFC-009 §5.3 AURC):
 * gapTau values are NOW DYNAMIC — thresholds returned by computeDynamicGapThreshold()
 * override static fallback values below. The static values here serve as:
 * - Documentation baseline
 * - Fallback for any query class not explicitly handled by computeDynamicGapThreshold()
 * - Historical reference (v2.0.0 → v2.1.0 shift to dynamic thresholds)
 *
 * Key changes for semantic_preference:
 * - v2.0.0: 0.05 (5%) — too conservative, blocked valid fuzzy matches
 * - v2.1.0: dynamic 0.015 (1.5%) — matches intent, allows preference queries
 *   when confidence is reasonable (e.g., 0.59 confidence with 1.72% gap)
 *
 * Principle (RFC-009): wrong resolve is -1.5 utility, avoidable abstain is -0.3.
 * A threshold is too high if it causes 5+ avoidable abstains per wrong resolve
 * it prevents (breakeven: 1.5 / 0.3 = 5).
 *
 * These values are tuned via AURC (RFC-009 §5.3) on the gate eval set.
 * See computeDynamicGapThreshold() for query-class-specific logic.
 */
export const DEFAULT_THRESHOLD_PROFILE: ThresholdProfileV1 = {
  id: 'default-v2.1',
  version: '2.1.0',
  perQueryClass: {
    // gapTau static values are fallback; dynamic values are preferred
    short_entity: { resolveTau: 0.60, gapTau: 0.03 },
    ambiguous_short_form: { resolveTau: 0.75, gapTau: 0.08 },
    anchored_similarity: { resolveTau: 0.55, gapTau: 0.03 },
    pure_constraint: { resolveTau: 0.50, gapTau: 0.05 },
    semantic_preference: { resolveTau: 0.45, gapTau: 0.015 },
    comparison_query: { resolveTau: 0.65, gapTau: 0.10 },
    unknown: { resolveTau: 0.65, gapTau: 0.10 },
  },
  ambiguityPenaltyDefault: 0.10,
} as const;
