import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { buildRankedRouteResolveResult } from './search-usecase-ranked-route-resolve.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';

/**
 * Synthetic resolver output for the hybrid retrieval path (pool + ranker).
 */
export function buildHybridRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
): EntityResolveResult {
  const topResult = rankedResults[0];
  const topEntity = topResult
    ? {
        entityId: topResult.entityId,
        canonicalLabel: topResult.canonicalLabel,
        calibratedScore: clamp01(topResult.finalScore),
      }
    : undefined;

  return buildRankedRouteResolveResult(plan, rankedResults, {
    outcomeReasonCode: 'HYBRID_ROUTE',
    ...(topEntity !== undefined ? { topEntity } : {}),
  });
}
