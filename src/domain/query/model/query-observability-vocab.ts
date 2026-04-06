import type { QueryPlanV1, QueryPlanV2 } from './query-plan.js';

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

type PlanLike = QueryPlanV1 | QueryPlanV2;

export interface QueryObservabilitySlice {
  readonly queryId: string;
  readonly rawQuery: string;
  readonly queryFamily: QueryFamilyLabel;
  readonly intent: string;
  readonly queryClass: string;
  readonly suggestedRetrievalMode: string;
  readonly suggestedRoute: string;
  readonly anchorCount: number;
  readonly hardConstraintCount: number;
  readonly softConstraintCount: number;
  readonly overallUncertainty: number;
  readonly ambiguityDetected: boolean;
  readonly plannerVersion: string;
  readonly policyRuleVersion: string;
  readonly thresholdProfileId: string;
  readonly decompositionStrategy?: string | undefined;
  readonly decompositionConfidence?: number | undefined;
}

function getSuggestedRoute(plan: PlanLike): string {
  return 'suggestedRoute' in plan ? plan.suggestedRoute : plan.route;
}

function getSuggestedRetrievalMode(plan: PlanLike): string {
  return 'suggestedRetrievalMode' in plan ? plan.suggestedRetrievalMode : plan.retrievalMode;
}

function deriveQueryFamily(plan: PlanLike): QueryFamilyLabel {
  const mode = getSuggestedRetrievalMode(plan);
  const intent = plan.intent;
  const decompositionHint = 'decompositionHint' in plan ? plan.decompositionHint : undefined;

  if (mode === 'no_match_detection') return 'no_match';
  if (mode === 'producer_browse') return 'producer_browse';
  if (mode === 'region_browse') return 'region_browse';
  if (mode === 'compare_candidates') return 'comparison';
  if (mode === 'recommendation' || mode === 'similar_items') return 'recommendation';

  if (plan.uncertainty.ambiguityDetected) return 'ambiguous';

  if (decompositionHint?.strategy === 'comparison') return 'comparison';
  if (decompositionHint !== undefined && decompositionHint.strategy !== 'none') {
    return 'multi_intent';
  }

  if (intent === 'entity_exact') return 'entity_exact';
  if (intent === 'entity_fuzzy') return 'entity_fuzzy';
  if (intent === 'pairing_search') return 'pairing';
  if (intent === 'comparison_search' || intent === 'mixed_query') return 'comparison';
  if (intent === 'semantic_discovery' || intent === 'budget_search') return 'entity_resolution';

  if (mode === 'constraint_filter' || mode === 'attribute_search') return 'attribute_constrained';

  return 'unknown';
}

export function planToObservabilitySlice(
  queryId: string,
  plan: PlanLike,
): QueryObservabilitySlice {
  const decompositionHint = 'decompositionHint' in plan ? plan.decompositionHint : undefined;

  return {
    queryId,
    rawQuery: plan.rawQuery.slice(0, 200),
    queryFamily: deriveQueryFamily(plan),
    intent: plan.intent,
    queryClass: plan.queryClass,
    suggestedRetrievalMode: getSuggestedRetrievalMode(plan),
    suggestedRoute: getSuggestedRoute(plan),
    anchorCount: plan.anchors.length,
    hardConstraintCount: plan.constraints.hard.length,
    softConstraintCount: plan.constraints.soft.length,
    overallUncertainty: plan.uncertainty.overall,
    ambiguityDetected: plan.uncertainty.ambiguityDetected,
    plannerVersion: plan.plannerVersion,
    policyRuleVersion: plan.policyRuleVersion,
    thresholdProfileId: plan.thresholdProfileId,
    ...(decompositionHint !== undefined
      ? {
          decompositionStrategy: decompositionHint.strategy,
          decompositionConfidence: decompositionHint.confidence,
        }
      : {}),
  };
}
