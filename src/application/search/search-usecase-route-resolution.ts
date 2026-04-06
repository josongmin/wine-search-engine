import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { SearchRequest } from './search-request.dto.js';

/**
 * Effective route when the client passes `options.mode` (not top-level `retrieval_mode`).
 */
export function resolveRouteFromPlanAndOptionMode(
  plan: QueryPlanV1,
  mode?: 'auto' | 'entity' | 'hybrid' | 'mixed',
): QueryRoute {
  if (mode === undefined || mode === 'auto') {
    if (
      plan.retrievalMode === 'producer_browse' ||
      plan.retrievalMode === 'region_browse' ||
      plan.retrievalMode === 'compare_candidates' ||
      plan.retrievalMode === 'recommendation'
    ) {
      return 'hybrid';
    }
    return plan.route;
  }
  return mode;
}

export interface SearchRouteResolutionContext {
  readonly apiOverrideMode: 'entity' | 'hybrid' | 'mixed' | undefined;
  readonly effectiveRoute: QueryRoute;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: QueryRoute;
}

/**
 * Combines top-level `retrieval_mode` override with planner route and `options.mode`.
 */
export function buildSearchRouteResolutionContext(
  plan: QueryPlanV1,
  request: SearchRequest,
): SearchRouteResolutionContext {
  const apiOverrideMode =
    request.retrieval_mode !== undefined && request.retrieval_mode !== 'auto'
      ? request.retrieval_mode
      : undefined;
  const effectiveRoute =
    apiOverrideMode ?? resolveRouteFromPlanAndOptionMode(plan, request.options?.mode);
  const retrievalModeSource: 'planner' | 'api_override' =
    apiOverrideMode !== undefined ? 'api_override' : 'planner';
  return {
    apiOverrideMode,
    effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode: plan.route,
  };
}
