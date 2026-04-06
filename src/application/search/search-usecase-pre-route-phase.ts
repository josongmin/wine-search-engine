import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import { analyzeQueryDecomposition, isValidDecomposition } from '../../domain/query/service/decomposition-detector.js';
import type { QueryPlannerPort } from './port/search-pipeline-deps.port.js';
import type { ResponseBuilderPort } from './port/search-pipeline-deps.port.js';
import type { DecomposedSearchUseCasePort } from './port/search-route-usecases.port.js';
import type { SearchRequest } from './search-request.dto.js';
import { buildConstraintContradictionExitParams } from './search-usecase-constraint-early-exit.js';
import { mergeCachedSearchResponseMeta } from './search-usecase-cache-hit.js';
import { tryGetCachedSearchResponse } from './search-usecase-cache-lookup.js';
import type { SnapshotVersionInjection } from './search-usecase-cache-lookup.js';
import { buildPlannerContextFromSearchRequest } from './search-usecase-planner-context.js';
import { createSearchQuerySecurityGate, type SearchSecurityGateDeps } from './search-usecase-security-gate.js';
import { logSearchEvent } from '../../observability/log-search-event.js';
import { planToObservabilitySlice } from '../../domain/query/model/query-observability-vocab.js';

export type SearchPreRouteEarlyResponse = SearchResponseV1 | ComparisonSearchResponse;

export type SearchPreRoutePhaseResult =
  | { readonly outcome: 'continue'; readonly plan: QueryPlanV1 }
  | { readonly outcome: 'return'; readonly response: SearchPreRouteEarlyResponse };

export interface SearchPreRoutePhaseContext {
  readonly request: SearchRequest;
  readonly requestId: string;
  readonly startTime: number;
  readonly snapshotVersions: SnapshotVersionInjection;
  readonly securityGateDeps: SearchSecurityGateDeps;
  readonly queryPlanner: QueryPlannerPort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly constraintSAT: ConstraintSAT;
  readonly cacheService?: SearchResponseCachePort | undefined;
  readonly decomposedSearch?: DecomposedSearchUseCasePort | undefined;
}

/**
 * Sanitize → optional Epic 14 comparison → plan → constraint-SAT → optional cache hit.
 */
export async function runSearchPreRoutePhase(
  ctx: SearchPreRoutePhaseContext,
): Promise<SearchPreRoutePhaseResult> {
  const securityGate = createSearchQuerySecurityGate(ctx.securityGateDeps);
  const sanitizedQuery = await securityGate.getSafeQueryOrThrow(ctx.request.query);

  if (ctx.decomposedSearch) {
    const decomposition = analyzeQueryDecomposition(sanitizedQuery);
    if (isValidDecomposition(decomposition.outcome)) {
      const response = await ctx.decomposedSearch.execute(
        decomposition.outcome.subQueries,
        decomposition.outcome.comparisonIntent,
        sanitizedQuery,
        ctx.requestId,
        ctx.startTime,
        {
          ...(ctx.request.context !== undefined ? { context: ctx.request.context } : {}),
          ...(ctx.request.sessionContext !== undefined
            ? { sessionContext: ctx.request.sessionContext }
            : {}),
          ...(ctx.request.queryBudget !== undefined ? { queryBudget: ctx.request.queryBudget } : {}),
        },
      );
      logSearchEvent({
        runtime_correlation_ref: ctx.requestId,
        decomposition_strategy: decomposition.hint.strategy,
      });
      return { outcome: 'return', response };
    }
  }

  const plan = await ctx.queryPlanner.plan(
    sanitizedQuery,
    buildPlannerContextFromSearchRequest(ctx.request),
  );

  logSearchEvent({
    runtime_correlation_ref: ctx.requestId,
    query_observability: planToObservabilitySlice(ctx.requestId, plan),
    ...(plan.decompositionHint !== undefined
      ? { decomposition_strategy: plan.decompositionHint.strategy }
      : {}),
  });

  const satResult = ctx.constraintSAT.check(plan.constraints);
  if (satResult.contradicted) {
    const response = ctx.responseBuilder.build(
      buildConstraintContradictionExitParams(
        plan,
        ctx.request,
        ctx.requestId,
        ctx.startTime,
        ctx.snapshotVersions,
        satResult.conflictPairs,
      ),
    );
    return { outcome: 'return', response };
  }

  if (ctx.cacheService) {
    const cached = await tryGetCachedSearchResponse(
      ctx.cacheService,
      plan,
      ctx.request,
      ctx.snapshotVersions,
    );
    if (cached !== undefined) {
      const response = mergeCachedSearchResponseMeta(
        cached,
        ctx.requestId,
        ctx.startTime,
      );
      return { outcome: 'return', response };
    }
  }

  return { outcome: 'continue', plan };
}
