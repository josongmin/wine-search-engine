import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../domain/resolver/service/resolver.js';

/**
 * Synthetic resolver output for the hybrid retrieval path (pool + ranker).
 */
export function buildHybridRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
): EntityResolveResult {
  const top1Score = rankedResults[0]?.finalScore ?? 0;
  const top2Score = rankedResults[1]?.finalScore ?? 0;
  const hybridConfidence = Math.max(0, Math.min(1, top1Score));
  const hybridGap = Math.max(0, Math.min(1, top1Score - top2Score));

  const topResult = rankedResults[0];
  const topEntity = topResult
    ? {
        entityId: topResult.entityId,
        canonicalLabel: topResult.canonicalLabel,
        calibratedScore: Math.max(0, Math.min(1, topResult.finalScore)),
      }
    : undefined;

  return {
    status: rankedResults.length > 0 ? 'resolved' : 'failed',
    ...(topEntity !== undefined ? { topEntity } : {}),
    candidates: [],
    decisionConfidenceC: hybridConfidence,
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: hybridConfidence,
      top2CalibratedScore: Math.max(0, Math.min(1, top2Score)),
      calibratedGap: hybridGap,
      decisionConfidenceC: hybridConfidence,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: ['HYBRID_ROUTE'],
    },
    conformalSetSize: computeConformalSetSize(hybridConfidence, DEFAULT_ALPHA, rankedResults.length),
  };
}
