import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../domain/resolver/service/resolver.js';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface RankedRouteResolveOptions {
  readonly outcomeReasonCode: 'HYBRID_ROUTE' | 'MIXED_ROUTE';
  readonly topEntity?: EntityResolveResult['topEntity'];
}

/**
 * Builds synthetic resolver output for ranked routes whose candidate ordering
 * already comes from retrieval/ranking rather than the entity resolver.
 */
export function buildRankedRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  options: RankedRouteResolveOptions,
): EntityResolveResult {
  const topResult = rankedResults[0];
  const top1Score = clamp01(rankedResults[0]?.finalScore ?? 0);
  const top2Score = clamp01(rankedResults[1]?.finalScore ?? 0);
  const calibratedGap = Math.max(0, top1Score - top2Score);
  const topEntity = options.topEntity
    ?? (topResult !== undefined
      ? {
          entityId: topResult.entityId,
          canonicalLabel: topResult.canonicalLabel,
          calibratedScore: top1Score,
        }
      : undefined);
  const candidates = topResult !== undefined
    ? [{
        entityId: topResult.entityId,
        canonicalLabel: topResult.canonicalLabel,
        calibratedScore: top1Score,
        rank: 1,
        evidenceRefs: topResult.evidenceItems.map((item) => item.type),
      }]
    : [];

  return {
    status: rankedResults.length > 0 ? 'resolved' : 'failed',
    ...(topEntity !== undefined ? { topEntity } : {}),
    candidates,
    decisionConfidenceC: top1Score,
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: top1Score,
      top2CalibratedScore: top2Score,
      calibratedGap,
      decisionConfidenceC: top1Score,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [options.outcomeReasonCode],
    },
    conformalSetSize: computeConformalSetSize(top1Score, DEFAULT_ALPHA, rankedResults.length),
  };
}
