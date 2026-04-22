import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type {
  ExecutionRetrievalMode,
  ExecutionTopology,
} from '../../domain/query/model/engine-execution-contract.js';
import type { SearchRequest } from './search-request.dto.js';

/**
 * Effective route when the client passes `options.mode` (not top-level `retrieval_mode`).
 * Compiled execution contract is required; V1 fallback semantics are intentionally removed.
 */
export function resolveRouteFromPlanAndOptionMode(
  _plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  mode?: 'auto' | 'entity' | 'hybrid' | 'mixed',
): QueryRoute {
  if (mode === undefined || mode === 'auto') {
    return compiled.execution.effectiveRoute;
  }
  return mode;
}

interface SearchRouteResolutionContext {
  readonly apiOverrideMode: 'entity' | 'hybrid' | 'mixed' | undefined;
  readonly effectiveRoute: QueryRoute;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: ExecutionRetrievalMode;
}

function resolveApiOverrideMode(
  request: SearchRequest,
): 'entity' | 'hybrid' | 'mixed' | undefined {
  if (request.retrieval_mode !== undefined && request.retrieval_mode !== 'auto') {
    return request.retrieval_mode;
  }

  const optionMode = request.options?.mode;
  if (optionMode !== undefined && optionMode !== 'auto') {
    return optionMode;
  }

  return undefined;
}

export function resolveExecutionTopologyFromRequestSurface(
  compiled: CompiledWineQuery,
  request: SearchRequest,
): ExecutionTopology {
  const apiOverrideMode = resolveApiOverrideMode(request);
  if (apiOverrideMode !== undefined) {
    return apiOverrideMode === 'entity' ? 'entity_only' : 'general_only';
  }

  switch (compiled.execution.effectiveRoute) {
    case 'entity':
      return 'entity_only';
    case 'hybrid':
      return 'dual_lane';
    case 'mixed':
      return 'general_only';
    default: {
      const _exhaustive: never = compiled.execution.effectiveRoute;
      throw new Error(`Unhandled effective route for execution topology: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Combines top-level `retrieval_mode` override with compiled execution contract and request options.
 *
 * Compiled-first semantics (E1-U5):
 * - When `compiled` is provided, `compiled.execution.effectiveRoute` is the authoritative source
 *   for the effective route.
 * - `plannerSuggestedMode` always carries an execution retrieval mode, never a route string.
 */
export function buildSearchRouteResolutionContext(
  plan: QueryPlanV1,
  request: SearchRequest,
  compiled: CompiledWineQuery,
): SearchRouteResolutionContext {
  const apiOverrideMode = resolveApiOverrideMode(request);
  const effectiveRoute =
    apiOverrideMode ?? resolveRouteFromPlanAndOptionMode(plan, compiled, request.options?.mode);
  const retrievalModeSource: 'planner' | 'api_override' =
    apiOverrideMode !== undefined ? 'api_override' : 'planner';
  const plannerSuggestedMode = compiled.execution.effectiveRetrievalMode;
  return {
    apiOverrideMode,
    effectiveRoute,
    retrievalModeSource,
    plannerSuggestedMode,
  };
}
