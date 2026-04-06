import type { MixedQueryResult } from '../../domain/mixed/model/mixed-query-result.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../domain/resolver/service/resolver.js';
import type { SearchRouteExecutionResult } from './search-usecase-route-dispatch.js';

/**
 * Synthetic resolver output for the mixed query route (anchor + similarity + constraints).
 */
export function buildMixedRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  mixedDecisionC: number,
): EntityResolveResult {
  return {
    status: rankedResults.length > 0 ? 'resolved' : 'failed',
    candidates: [],
    decisionConfidenceC: mixedDecisionC,
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: mixedDecisionC,
      top2CalibratedScore: 0,
      calibratedGap: mixedDecisionC,
      decisionConfidenceC: mixedDecisionC,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: ['MIXED_ROUTE'],
    },
    conformalSetSize: computeConformalSetSize(mixedDecisionC, DEFAULT_ALPHA, rankedResults.length),
  };
}

/**
 * Maps {@link MixedSolver} output to the same shape as hybrid/entity route dispatch.
 */
export function mixedQueryResultToSearchRouteExecution(
  plan: QueryPlanV1,
  mixedResult: MixedQueryResult,
): SearchRouteExecutionResult {
  const rankedResults = mixedResult.rankedResults;
  const mixedDecisionC = mixedResult.anchor.anchorConfidence;
  return {
    resolveResult: buildMixedRouteResolveResult(plan, rankedResults, mixedDecisionC),
    rankedResults,
  };
}
