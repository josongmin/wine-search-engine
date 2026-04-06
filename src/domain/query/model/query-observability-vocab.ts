/**
 * T2.5: Query Understanding Observability Vocabulary
 *
 * Canonical labels + slice structure for query understanding telemetry.
 * Used in structured logs, dashboards, and offline eval alignment.
 */

import type { QueryPlanV2 } from './query-plan.js';

// ---------------------------------------------------------------------------
// Query family labels (bucketed intent × query class × retrieval mode)
// ---------------------------------------------------------------------------

export const QUERY_FAMILY_LABELS = [
  'entity_exact',
  'entity_fuzzy',
  'entity_resolution',
  'attribute_constrained',
  'producer_browse',
  'region_browse',
  'comparison',
  'recommendation',
  'pairing',
  'multi_intent',
  'no_match',
  'ambiguous',
  'unknown',
] as const;

export type QueryFamilyLabel = (typeof QUERY_FAMILY_LABELS)[number];

// ---------------------------------------------------------------------------
// Observability slice — emitted per query plan in structured logs
// ---------------------------------------------------------------------------

export interface QueryObservabilitySlice {
  /** Unique query ID for this request (usually requestId). */
  readonly queryId: string;

  /** Raw query string (may be truncated for log safety). */
  readonly rawQuery: string;

  /** Bucketed family label for dashboards. */
  readonly queryFamily: QueryFamilyLabel;

  /** Planner intent field. */
  readonly intent: string;

  /** Query class from planner (short_entity, long_constraint, etc.). */
  readonly queryClass: string;

  /** Planner's suggested retrieval mode. */
  readonly suggestedRetrievalMode: string;

  /** Planner's suggested route. */
  readonly suggestedRoute: string;

  /** Number of anchors extracted. */
  readonly anchorCount: number;

  /** Number of hard constraints. */
  readonly hardConstraintCount: number;

  /** Number of soft constraints. */
  readonly softConstraintCount: number;

  /** Overall uncertainty score (0–1). */
  readonly overallUncertainty: number;

  /** Whether ambiguity was detected. */
  readonly ambiguityDetected: boolean;

  /** Planner version for longitudinal tracking. */
  readonly plannerVersion: string;

  /** Policy rule version. */
  readonly policyRuleVersion: string;

  /** Threshold profile ID. */
  readonly thresholdProfileId: string;
}

// ---------------------------------------------------------------------------
// Factory: QueryPlanV2 → QueryObservabilitySlice
// ---------------------------------------------------------------------------

function deriveQueryFamily(plan: QueryPlanV2): QueryFamilyLabel {
  const mode = plan.suggestedRetrievalMode;
  const intent = plan.intent;

  if (mode === 'no_match_detection') return 'no_match';
  if (mode === 'producer_browse') return 'producer_browse';
  if (mode === 'region_browse') return 'region_browse';
  if (mode === 'compare_candidates') return 'comparison';
  if (mode === 'recommendation') return 'recommendation';
  if (mode === 'similar_items') return 'recommendation';

  if (intent === 'entity_exact') return 'entity_exact';
  if (intent === 'entity_fuzzy') return 'entity_fuzzy';

  if (plan.uncertainty.ambiguityDetected) return 'ambiguous';

  if (mode === 'attribute_search' || mode === 'constraint_filter') {
    return 'attribute_constrained';
  }

  return 'unknown';
}

/**
 * Build a QueryObservabilitySlice from a QueryPlanV2 and a queryId.
 * Safe for structured logging (no circular refs, bounded size).
 */
export function planToObservabilitySlice(
  queryId: string,
  plan: QueryPlanV2,
): QueryObservabilitySlice {
  return {
    queryId,
    rawQuery: plan.rawQuery.slice(0, 200), // truncate for log safety
    queryFamily: deriveQueryFamily(plan),
    intent: plan.intent,
    queryClass: plan.queryClass,
    suggestedRetrievalMode: plan.suggestedRetrievalMode,
    suggestedRoute: plan.suggestedRoute,
    anchorCount: plan.anchors.length,
    hardConstraintCount: plan.constraints.hard.length,
    softConstraintCount: plan.constraints.soft.length,
    overallUncertainty: plan.uncertainty.overall,
    ambiguityDetected: plan.uncertainty.ambiguityDetected,
    plannerVersion: plan.plannerVersion,
    policyRuleVersion: plan.policyRuleVersion,
    thresholdProfileId: plan.thresholdProfileId,
  };
}
