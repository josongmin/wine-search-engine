import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../domain/resolver/service/resolver.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';
import type { ExecutionRetrievalMode } from '../../domain/query/model/engine-execution-contract.js';
import type {
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
} from '../../domain/retrieval/model/dual-lane-artifact.js';
import type { SearchExecutionLaneArtifacts } from './search-usecase-route-dispatch.js';
import { DualLaneResolveCalibrator } from './search-usecase-dual-lane-resolve-calibrator.js';

const DUAL_LANE_RESOLVE_CALIBRATOR = new DualLaneResolveCalibrator();

interface RankedRouteResolveOptionsBase {
  readonly outcomeReasonCode: 'HYBRID_ROUTE' | 'MIXED_ROUTE';
  readonly topEntity?: EntityResolveResult['topEntity'];
  readonly effectiveRetrievalMode?: ExecutionRetrievalMode | undefined;
}

interface GeneralOnlyRankedRouteResolveOptions extends RankedRouteResolveOptionsBase {
  readonly executionTopology: 'general_only';
}

interface DualLaneRankedRouteResolveOptions extends RankedRouteResolveOptionsBase {
  readonly executionTopology: 'dual_lane';
  readonly dualLaneCalibration?: {
    readonly identityResolveResult: EntityResolveResult;
    readonly laneArtifacts: SearchExecutionLaneArtifacts<
      EntityLaneCandidateArtifact,
      GeneralLaneCandidateArtifact,
      DualLaneArtifact
    >;
  } | undefined;
}

type RankedRouteResolveOptions =
  | GeneralOnlyRankedRouteResolveOptions
  | DualLaneRankedRouteResolveOptions;

/**
 * Builds the fused ranked-route resolve contract directly from the live
 * ranking output. The live winner is always the top-ranked candidate; the
 * decision confidence is the top-1 posterior, optionally recalibrated at the
 * dual-lane seam.
 */
export function buildRankedRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  options: RankedRouteResolveOptions,
): EntityResolveResult {
  const topResult = rankedResults[0];
  const top1Score = clamp01(rankedResults[0]?.finalScore ?? 0);
  const decisionConfidenceC = top1Score;
  const top2Result = rankedResults[1];
  const top2Score = top2Result !== undefined
    ? clamp01(top2Result.finalScore)
    : undefined;
  const calibratedGap = top2Score !== undefined
    ? Math.max(0, top1Score - top2Score)
    : undefined;
  const topEntity = options.topEntity
    ?? (topResult !== undefined
      ? {
          entityId: topResult.entityId,
          canonicalLabel: topResult.canonicalLabel,
          calibratedScore: top1Score,
        }
      : undefined);
  const candidates = rankedResults.map((result, index) => ({
    entityId: result.entityId,
    canonicalLabel: result.canonicalLabel,
    calibratedScore: clamp01(result.finalScore),
    rank: index + 1,
    // Ranked-route fused resolve results do not carry resolver
    // identity refs. Decision-input assembly derives identity semantics
    // from ranked-route alignment instead of reusing ranking evidence.
    evidenceRefs: [],
  }));

  // Ranked-route calibrator insertion point. DualLaneResolveCalibrator is the
  // only allowed calibrator at this seam and runs below, after ranked results
  // are fixed and before the fused resolve contract is emitted. Do NOT
  // add a second insertion point in the decision layer.

  const fusedResolveResult: EntityResolveResult = {
    status: rankedResults.length > 0 ? 'resolved' : 'failed',
    ...(topEntity !== undefined ? { topEntity } : {}),
    candidates,
    decisionConfidenceC,
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: top1Score,
      top2CalibratedScore: top2Score,
      calibratedGap,
      decisionConfidenceC,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [options.outcomeReasonCode],
    },
    conformalSetSize: computeConformalSetSize(top1Score, DEFAULT_ALPHA, rankedResults.length),
  };

  if (
    options.executionTopology !== 'dual_lane'
    || options.dualLaneCalibration === undefined
  ) {
    return fusedResolveResult;
  }

  return DUAL_LANE_RESOLVE_CALIBRATOR.calibrate({
    rankedResults,
    fusedResolveResult,
    identityResolveResult: options.dualLaneCalibration.identityResolveResult,
    effectiveRetrievalMode: options.effectiveRetrievalMode,
    laneArtifacts: options.dualLaneCalibration.laneArtifacts,
  });
}
