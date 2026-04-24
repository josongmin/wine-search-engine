import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { ExecutionRetrievalMode } from '../../domain/query/model/engine-execution-contract.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type {
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
} from '../../domain/retrieval/model/dual-lane-artifact.js';
import type { SearchExecutionLaneArtifacts } from './search-usecase-route-dispatch.js';
import { buildRankedRouteResolveResult } from './search-usecase-ranked-route-resolve.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';

/**
 * Fused resolve output for the hybrid retrieval path (pool + ranker).
 */
export function buildHybridRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  options: {
    readonly executionTopology: 'general_only' | 'dual_lane';
    readonly effectiveRetrievalMode?: ExecutionRetrievalMode | undefined;
    readonly identityCalibration?: {
      readonly identityResolveResult: EntityResolveResult;
      readonly laneArtifacts: SearchExecutionLaneArtifacts<
        EntityLaneCandidateArtifact,
        GeneralLaneCandidateArtifact,
        DualLaneArtifact
      >;
    } | undefined;
  },
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
    executionTopology: options.executionTopology,
    ...(options.effectiveRetrievalMode !== undefined
      ? { effectiveRetrievalMode: options.effectiveRetrievalMode }
      : {}),
    ...(topEntity !== undefined ? { topEntity } : {}),
    ...(options.identityCalibration !== undefined
      ? { identityCalibration: options.identityCalibration }
      : {}),
  });
}
