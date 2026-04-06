import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { ResponseBuildParams } from '../../domain/response/service/response-builder.js';
import type { SearchRequest } from './search-request.dto.js';
import { buildConstraintContradictionResponseParams } from './search-usecase-execute-builders.js';
import { formatConstraintConflictDescription } from './search-usecase-constraint-conflict.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { buildSearchRouteResolutionContext } from './search-usecase-route-resolution.js';
import type { SnapshotVersionInjection } from './search-usecase-cache-lookup.js';

/**
 * Full {@link ResponseBuildParams} for constraint-SAT contradiction (no retrieval).
 */
export function buildConstraintContradictionExitParams(
  plan: QueryPlanV1,
  request: SearchRequest,
  requestId: string,
  startTime: number,
  snapshotVersions: SnapshotVersionInjection,
  conflictPairs: ReadonlyArray<readonly [NormalizedConstraint, NormalizedConstraint]>,
): ResponseBuildParams {
  const routeCtx = buildSearchRouteResolutionContext(plan, request);
  return buildConstraintContradictionResponseParams({
    plan,
    snapshot: buildDecisionSnapshotFromPlan(plan, snapshotVersions),
    requestId,
    startTime,
    conflictDesc: formatConstraintConflictDescription(conflictPairs),
    effectiveRoute: routeCtx.effectiveRoute,
    retrievalModeSource: routeCtx.retrievalModeSource,
    plannerSuggestedMode: routeCtx.plannerSuggestedMode,
  });
}
