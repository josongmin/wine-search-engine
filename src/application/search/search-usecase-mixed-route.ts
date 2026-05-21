import type { MixedQueryResult } from '../../domain/mixed/model/mixed-query-result.js';
import type { MixedFallbackReason } from '../../domain/mixed/model/mixed-degradation.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import {
  buildEmptySearchExecutionLaneArtifacts,
  buildSearchExecutionLaneTrace,
  type SearchRouteExecutionResult,
} from './search-usecase-route-dispatch.js';
import { buildRankedRouteResolveResult } from './search-usecase-ranked-route-resolve.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';

/**
 * Synthetic resolver output for the mixed query route (anchor + similarity + constraints).
 */
export function buildMixedRouteResolveResult(
  plan: QueryPlanV1,
  rankedResults: readonly RankedResult[],
  _mixedResult: MixedQueryResult,
  effectiveRetrievalMode?: CompiledWineQuery['execution']['effectiveRetrievalMode'],
): EntityResolveResult {
  return buildRankedRouteResolveResult(plan, rankedResults, {
    outcomeReasonCode: 'MIXED_ROUTE',
    executionTopology: 'general_only',
    ...(effectiveRetrievalMode !== undefined ? { effectiveRetrievalMode } : {}),
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
  compiled: CompiledWineQuery,
): SearchRouteExecutionResult {
  const rankedResults = mixedResult.rankedResults;
  const fusedResolveResult = buildMixedRouteResolveResult(
    plan,
    rankedResults,
    mixedResult,
    compiled.execution.effectiveRetrievalMode,
  );
  const laneArtifacts = buildEmptySearchExecutionLaneArtifacts();
  return {
    executedCompiled: compiled,
    executionTopology: 'general_only',
    identityResolveResult: null,
    fusedResolveResult,
    laneArtifacts,
    laneTrace: buildSearchExecutionLaneTrace({
      executionTopology: 'general_only',
      identityResolveResult: null,
      fusedResolveResult,
      laneArtifacts,
    }),
    rankedResults,
    effectiveRetrievalMode: compiled.execution.effectiveRetrievalMode,
    retrievalKind: 'mixed_similarity',
    sparseExecuted: false,
    specializedRouteExecuted: null,
    usedCompiledExecution: true,
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
  compiled: CompiledWineQuery,
): SearchRouteExecutionResult {
  const fusedResolveResult: EntityResolveResult = {
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: 0,
      top2CalibratedScore: undefined,
      calibratedGap: undefined,
      decisionConfidenceC: 0,
      // Mixed-route failure path never invoked the trained Calibrator, so
      // `decisionConfidenceC=0` is a sentinel. Flag the trace as untrusted
      // so the AdmissionGate's confidence-refusal floor (RFC-016 §3, Epic
      // 17.3) skips enforcement on this fallback.
      calibrationTrusted: false,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: ['MIXED_ROUTE'],
    },
    degradation: { reasons: [reason] },
    conformalSetSize: 1,
  };
  const laneArtifacts = buildEmptySearchExecutionLaneArtifacts();

  return {
    executedCompiled: compiled,
    executionTopology: 'general_only',
    identityResolveResult: null,
    fusedResolveResult,
    laneArtifacts,
    laneTrace: buildSearchExecutionLaneTrace({
      executionTopology: 'general_only',
      identityResolveResult: null,
      fusedResolveResult,
      laneArtifacts,
    }),
    rankedResults: [],
    effectiveRetrievalMode: compiled.execution.effectiveRetrievalMode,
    retrievalKind: 'mixed_similarity',
    sparseExecuted: false,
    specializedRouteExecuted: null,
    usedCompiledExecution: true,
    routeDegradation: {
      executionMode: 'degraded',
      degradationReasons: [reason],
    },
    fallbackReason: reason,
  };
}
