import type { MixedQueryResult } from '../../domain/mixed/model/mixed-query-result.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { SearchRouteExecutionResult } from './search-usecase-route-dispatch.js';
import { buildRankedRouteResolveResult } from './search-usecase-ranked-route-resolve.js';

/**
 * Synthetic resolver output for the mixed query route (anchor + similarity + constraints).
 */
export function buildMixedRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  _mixedResult: MixedQueryResult,
): EntityResolveResult {
  return buildRankedRouteResolveResult(plan, rankedResults, {
    outcomeReasonCode: 'MIXED_ROUTE',
    topEntity: rankedResults[0] === undefined
      ? undefined
      : {
          entityId: rankedResults[0].entityId,
          canonicalLabel: rankedResults[0].canonicalLabel,
          calibratedScore: Math.max(0, Math.min(1, rankedResults[0].finalScore)),
        },
  });
}

/**
 * Maps {@link MixedSolver} output to the same shape as hybrid/entity route dispatch.
 */
export function mixedQueryResultToSearchRouteExecution(
  plan: QueryPlanV1,
  mixedResult: MixedQueryResult,
): SearchRouteExecutionResult {
  const rankedResults = mixedResult.rankedResults;
  return {
    resolveResult: buildMixedRouteResolveResult(plan, rankedResults, mixedResult),
    rankedResults,
    decisionContext: {
      mixedAnchor: {
        entityId: mixedResult.anchor.entityId,
        canonicalLabel: mixedResult.anchor.canonicalLabel,
        confidence: mixedResult.anchor.anchorConfidence,
      },
    },
  };
}
