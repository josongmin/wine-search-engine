import type { MixedQueryResult } from '../../domain/mixed/model/mixed-query-result.js';
import type { MixedFallbackReason } from '../../domain/mixed/model/mixed-degradation.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { SearchRouteExecutionResult } from './search-usecase-route-dispatch.js';
import { buildRankedRouteResolveResult } from './search-usecase-ranked-route-resolve.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';

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
          calibratedScore: clamp01(rankedResults[0].finalScore),
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
    ...(mixedResult.routeDegradation !== undefined
      ? { routeDegradation: mixedResult.routeDegradation }
      : {}),
    ...(mixedResult.fallbackReason !== undefined
      ? { fallbackReason: mixedResult.fallbackReason }
      : {}),
    ...(mixedResult.funnelMetrics !== undefined
      ? { funnelMetrics: mixedResult.funnelMetrics }
      : {}),
  };
}

export function buildFailedMixedRouteExecution(
  plan: QueryPlanV1,
  reason: MixedFallbackReason,
): SearchRouteExecutionResult {
  const resolveResult: EntityResolveResult = {
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: 0,
      top2CalibratedScore: 0,
      calibratedGap: 0,
      decisionConfidenceC: 0,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: ['MIXED_ROUTE'],
    },
    degradation: { reasons: [reason] },
    conformalSetSize: 1,
  };

  return {
    resolveResult,
    rankedResults: [],
    routeDegradation: {
      executionMode: 'degraded',
      degradationReasons: [reason],
    },
    fallbackReason: reason,
  };
}
