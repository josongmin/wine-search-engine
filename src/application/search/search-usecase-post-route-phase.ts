import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { DecisionEnginePort, ResponseBuilderPort } from './port/search-pipeline-deps.port.js';
import type { SearchRequest } from './search-request.dto.js';
import { buildEntropyAbstainResponseParams } from './search-usecase-execute-builders.js';
import { buildSearchCacheRequestContext } from './search-usecase-cache-context.js';
import { buildSearchCounterfactuals } from './search-usecase-counterfactuals.js';
import { buildSearchDecisionInput } from './search-usecase-decision-input.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { mapRankedResultsToResultItems } from './search-usecase-map-result-items.js';
import { topKFinalScores } from './search-usecase-ranking-scores.js';
import type { SnapshotVersionInjection } from './search-usecase-cache-lookup.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

/**
 * Context for Steps 3b–7: entropy abstain → DecisionEngine → ResponseBuilder → optional cache write.
 */
export interface SearchPostRouteExecutionContext {
  readonly plan: QueryPlanV1;
  readonly request: SearchRequest;
  readonly requestId: string;
  readonly startTime: number;
  readonly resolveResult: EntityResolveResult;
  readonly rankedResults: readonly RankedResult[];
  readonly effectiveRoute: QueryRoute;
  readonly plannerSuggestedMode: QueryRoute;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly abstainPolicy: AbstainPolicy;
  readonly snapshotVersions: SnapshotVersionInjection;
  readonly drinkingWindow?: DrinkingWindowUseCasePort | undefined;
  readonly decisionEngine: DecisionEnginePort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly cacheService?: SearchResponseCachePort | undefined;
}

/**
 * After route execution: RFC-013 entropy gate, then decision + response + Wave 4 cache populate.
 */
export async function runSearchPostRoutePhase(
  ctx: SearchPostRouteExecutionContext,
): Promise<SearchResponseV1> {
  const topScores = topKFinalScores(ctx.rankedResults);
  const abstainDecision = ctx.abstainPolicy.shouldAbstain(topScores);

  if (abstainDecision.abstain) {
    const snapshot = buildDecisionSnapshotFromPlan(ctx.plan, ctx.snapshotVersions);
    const results = await mapRankedResultsToResultItems(
      ctx.rankedResults,
      ctx.drinkingWindow,
    );
    return ctx.responseBuilder.build(
      buildEntropyAbstainResponseParams({
        plan: ctx.plan,
        snapshot,
        requestId: ctx.requestId,
        startTime: ctx.startTime,
        effectiveRoute: ctx.effectiveRoute,
        retrievalModeSource: ctx.retrievalModeSource,
        plannerSuggestedMode: ctx.plannerSuggestedMode,
        entropy: abstainDecision.entropy,
        results,
        rankedResults: ctx.rankedResults,
      }),
    );
  }

  const decisionInput = buildSearchDecisionInput(
    ctx.plan,
    ctx.resolveResult,
    ctx.rankedResults,
  );
  const snapshot = buildDecisionSnapshotFromPlan(ctx.plan, ctx.snapshotVersions);
  const decisionOutput = await ctx.decisionEngine.decide(decisionInput, snapshot);

  const queryTimeMs = Date.now() - ctx.startTime;
  const results = await mapRankedResultsToResultItems(
    ctx.rankedResults,
    ctx.drinkingWindow,
  );
  const counterfactuals = buildSearchCounterfactuals(
    ctx.resolveResult,
    ctx.rankedResults,
  );

  const response = ctx.responseBuilder.build({
    queryPlan: ctx.plan,
    decisionOutput,
    results,
    counterfactuals: counterfactuals.length > 0 ? counterfactuals : undefined,
    requestId: ctx.requestId,
    queryTimeMs,
    route: ctx.effectiveRoute,
    retrievalModeSource: ctx.retrievalModeSource,
    plannerSuggestedMode: ctx.plannerSuggestedMode,
  });

  if (ctx.cacheService) {
    const stored = await ctx.cacheService.setSearchResponse(
      ctx.plan,
      buildSearchCacheRequestContext(ctx.request),
      response,
    );
    if (!stored) {
      bootstrapLogger.debug(
        { requestId: ctx.requestId },
        '[Search] setSearchResponse skipped (ineligible mode, circuit breaker, or policy)',
      );
    }
  }

  return response;
}
