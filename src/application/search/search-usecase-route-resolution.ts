import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import { QUERY_ROUTES, type QueryRoute } from '../../domain/query/model/query-route.js';
import { RETRIEVAL_MODES, retrievalModeToRoute } from '../../domain/query/model/retrieval-mode.js';
import type { SearchRequest } from './search-request.dto.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

function isQueryRoute(value: unknown): value is QueryRoute {
  return typeof value === 'string' && QUERY_ROUTES.includes(value as QueryRoute);
}

function resolvePlannerSuggestedRoute(plan: QueryPlanV1): QueryRoute {
  if (isQueryRoute(plan.route)) {
    return plan.route;
  }
  if (RETRIEVAL_MODES.includes(plan.retrievalMode)) {
    return retrievalModeToRoute(plan.retrievalMode);
  }
  bootstrapLogger.warn(
    { planRoute: plan.route, retrievalMode: plan.retrievalMode },
    '[RouteResolution] Invalid route from planner; falling back to hybrid',
  );
  return 'hybrid';
}

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
    return resolvePlannerSuggestedRoute(plan);
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
  const plannerSuggestedMode = resolvePlannerSuggestedRoute(plan);
  return {
    apiOverrideMode,
    effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode,
  };
}
