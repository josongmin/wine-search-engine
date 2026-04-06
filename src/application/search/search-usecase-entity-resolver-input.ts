import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { ResolverInput } from '../../domain/resolver/service/resolver.js';

/**
 * Maps a {@link QueryPlanV1} to entity resolver input (RFC-006).
 */
export function buildEntityResolverInputFromPlan(plan: QueryPlanV1): ResolverInput {
  return {
    rawQuery: plan.rawQuery,
    normalizedQuery: plan.normalizedQuery,
    ...(plan.normalizedQueryViews !== undefined
      ? { normalizedQueryViews: plan.normalizedQueryViews }
      : {}),
    queryClass: plan.queryClass,
    policy: plan.policy,
    anchorCandidates: plan.anchors,
    uncertainty: plan.uncertainty,
    candidateEntities: [],
  };
}
