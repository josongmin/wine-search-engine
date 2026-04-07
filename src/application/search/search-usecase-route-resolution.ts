import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import { QUERY_ROUTES, type QueryRoute } from '../../domain/query/model/query-route.js';
import { RETRIEVAL_MODES, retrievalModeToRoute } from '../../domain/query/model/retrieval-mode.js';
import type { ExecutionRetrievalMode } from '../../domain/query/model/engine-execution-contract.js';
import type { SearchRequest } from './search-request.dto.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

function isQueryRoute(value: unknown): value is QueryRoute {
  return typeof value === 'string' && QUERY_ROUTES.includes(value as QueryRoute);
}

/**
 * Fallback-only: derive planner suggested route from a V1 plan when compiled is unavailable.
 * @internal
 */
function resolvePlannerSuggestedRouteFromV1(plan: QueryPlanV1): QueryRoute {
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
 * Falls back to V1 plan fields when compiled is not available.
 * @internal
 */
export function resolveRouteFromPlanAndOptionMode(
  plan: QueryPlanV1,
  mode?: 'auto' | 'entity' | 'hybrid' | 'mixed',
  compiled?: CompiledWineQuery,
): QueryRoute {
  if (mode === undefined || mode === 'auto') {
    // Compiled-first: use ExecutionCompiler's resolved route when available.
    if (compiled !== undefined) {
      return compiled.execution.effectiveRoute;
    }
    // V1 fallback: replicate HYBRID_FORCED_MODES logic for plan-only callers.
    // WARNING: These modes must stay in sync with HYBRID_FORCED_MODES in ExecutionCompiler.
    // This fallback fires only when compiled is undefined (legacy planner adapter).
    // If you add a new forced-hybrid mode, update ExecutionCompiler first.
    if (
      plan.retrievalMode === 'producer_browse' ||
      plan.retrievalMode === 'region_browse' ||
      plan.retrievalMode === 'compare_candidates' ||
      plan.retrievalMode === 'recommendation'
    ) {
      return 'hybrid';
    }
    return resolvePlannerSuggestedRouteFromV1(plan);
  }
  return mode;
}

export interface SearchRouteResolutionContext {
  readonly apiOverrideMode: 'entity' | 'hybrid' | 'mixed' | undefined;
  readonly effectiveRoute: QueryRoute;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: ExecutionRetrievalMode | QueryRoute;
}

/**
 * Combines top-level `retrieval_mode` override with compiled execution contract and request options.
 *
 * Compiled-first semantics (E1-U5):
 * - When `compiled` is provided, `compiled.execution.effectiveRoute` is the authoritative source
 *   for the effective route. `plan.route` is a fallback-only value.
 * - When `compiled` is absent (legacy adapters), falls back to V1 plan fields.
 */
export function buildSearchRouteResolutionContext(
  plan: QueryPlanV1,
  request: SearchRequest,
  compiled?: CompiledWineQuery,
): SearchRouteResolutionContext {
  const apiOverrideMode =
    request.retrieval_mode !== undefined && request.retrieval_mode !== 'auto'
      ? request.retrieval_mode
      : undefined;
  const effectiveRoute =
    apiOverrideMode ?? resolveRouteFromPlanAndOptionMode(plan, request.options?.mode, compiled);
  const retrievalModeSource: 'planner' | 'api_override' =
    apiOverrideMode !== undefined ? 'api_override' : 'planner';
  // plannerSuggestedMode: compiled-first (fine-grained mode), V1 fallback (coarse route)
  const plannerSuggestedMode = compiled !== undefined
    ? compiled.execution.effectiveRetrievalMode
    : resolvePlannerSuggestedRouteFromV1(plan);
  return {
    apiOverrideMode,
    effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode,
  };
}
