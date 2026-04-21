import type { QueryClass } from '../../shared/types/index.js';

/** Decision gate mode used by a threshold entry. */
export type NumericGateMode = 'strict' | 'preference';

/** Semantic-preference gap when confidence is high (tighter disambiguation). */
const DYNAMIC_GAP_SEMANTIC_PREF_HIGH_CONFIDENCE = 0.01;
/** Semantic-preference standard gap (fuzzy NL). */
const DYNAMIC_GAP_SEMANTIC_PREF_STANDARD = 0.015;
/** Confidence floor to use tighter semantic-preference gap. */
const DYNAMIC_GAP_SEMANTIC_PREF_CONFIDENCE_FLOOR = 0.55;
/** Short-entity direct lookup gap. */
const DYNAMIC_GAP_SHORT_ENTITY = 0.03;
/** Ambiguous short-form requires wider separation. */
const DYNAMIC_GAP_AMBIGUOUS_SHORT_FORM = 0.08;
/** Anchored similarity gap (moderate). */
const DYNAMIC_GAP_ANCHORED_SIMILARITY = 0.03;
/** Pure constraint gap. */
const DYNAMIC_GAP_PURE_CONSTRAINT = 0.05;
/** Comparison and unknown-query fallback gap (strict winner). */
const DYNAMIC_GAP_WIDE = 0.1;

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

  /**
   * Numeric gate style for the query class.
   * - `strict`: identity-style gate uses confidence, gap, and conformal set size.
   * - `preference`: recommendation-style gate uses confidence only; gap/conformal
   *   remain observable in traces but do not block resolution.
   */
  readonly numericGateMode?: NumericGateMode;
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
    if (confidence > DYNAMIC_GAP_SEMANTIC_PREF_CONFIDENCE_FLOOR) {
      return DYNAMIC_GAP_SEMANTIC_PREF_HIGH_CONFIDENCE;
    }
    return DYNAMIC_GAP_SEMANTIC_PREF_STANDARD;
  }

  if (queryClass === 'exact_entity' || queryClass === 'short_entity') {
    return DYNAMIC_GAP_SHORT_ENTITY;
  }

  if (queryClass === 'ambiguous_short_form') {
    return DYNAMIC_GAP_AMBIGUOUS_SHORT_FORM;
  }

  if (queryClass === 'anchored_similarity') {
    return DYNAMIC_GAP_ANCHORED_SIMILARITY;
  }

  if (queryClass === 'pure_constraint') {
    return DYNAMIC_GAP_PURE_CONSTRAINT;
  }

  if (queryClass === 'comparison_query') {
    return DYNAMIC_GAP_WIDE;
  }

  return DYNAMIC_GAP_WIDE;
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
 * - v2.2.0: `numericGateMode: preference` — recommendation-style queries use
 *   confidence-only admission, with gap/conformal retained for observability.
 *
 * Principle (RFC-009): wrong resolve is -1.5 utility, avoidable abstain is -0.3.
 * A threshold is too high if it causes 5+ avoidable abstains per wrong resolve
 * it prevents (breakeven: 1.5 / 0.3 = 5).
 *
 * These values are tuned via AURC (RFC-009 §5.3) on the gate eval set.
 * See computeDynamicGapThreshold() for query-class-specific logic.
 */
/**
 * Heuristic-mode thresholds. Heuristic scores (clamp01 weighted sum) cluster
 * in [0.3, 0.7] with small gaps (~0.02-0.04). Thresholds are lowered so
 * that a clear top-1 winner resolves instead of every query being ambiguous.
 *
 * Calibrated against live search results (2026-04-13):
 *   Opus One → 0.66 (should resolve)
 *   Merlot   → 0.66 (category search, ambiguous OK)
 *   Barolo   → 0.50 (region search, ambiguous OK)
 */
export const DEFAULT_THRESHOLD_PROFILE: ThresholdProfileV1 = {
  id: 'heuristic-v1.0',
  version: '1.0.0',
  perQueryClass: {
    exact_entity: { resolveTau: 0.40, gapTau: 0.02 },
    short_entity: { resolveTau: 0.45, gapTau: 0.02 },
    ambiguous_short_form: { resolveTau: 0.50, gapTau: 0.03 },
    anchored_similarity: { resolveTau: 0.40, gapTau: 0.02 },
    pure_constraint: { resolveTau: 0.35, gapTau: 0.02 },
    semantic_preference: { resolveTau: 0.35, gapTau: 0.01, numericGateMode: 'preference' },
    comparison_query: { resolveTau: 0.50, gapTau: 0.05 },
    unknown: { resolveTau: 0.50, gapTau: 0.05 },
  },
  ambiguityPenaltyDefault: 0.10,
} as const;
