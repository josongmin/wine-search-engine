import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type {
  ExecutionLaneTrace,
  ExecutionRetrievalMode,
  ExecutionTopology,
} from '../../domain/query/model/engine-execution-contract.js';
import type { FunnelMetrics } from '../../domain/ranking/model/ranking-stage.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { RankingMetadata } from '../../domain/ranking/port/ranker.port.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { RrfFusionTrace, CandidateDropRecord } from '../../domain/retrieval/model/candidate-envelope.js';
import type { SpecializedRouteName } from '../../domain/response/model/specialized-route.js';
import type { SpecializedRouteObservability } from './specialized-route-observability.js';
import type { DecisionInputCriticRewrite } from '../../domain/decision/model/decision-input.js';

export type SearchRouteRetrievalKind =
  | 'entity_lookup'
  | 'generic_hybrid'
  | 'specialized_hybrid'
  | 'mixed_similarity';

export interface SearchRouteDecisionContext {
  readonly mixedAnchor?: {
    readonly entityId: CanonicalEntityId;
    readonly canonicalLabel: string;
    readonly confidence: number;
  } | undefined;
}

export interface SearchExecutionLaneArtifactRef {
  readonly entityId: CanonicalEntityId;
  readonly canonicalLabel?: string | undefined;
}

export interface SearchExecutionLaneArtifacts<
  TIdentityArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
  TGeneralArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
  TFusedArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
> {
  readonly identity: readonly TIdentityArtifact[];
  readonly general: readonly TGeneralArtifact[];
  readonly fused: readonly TFusedArtifact[];
}

export interface SearchExecutionResolveSet<
  TIdentityResolveResult extends EntityResolveResult | null = EntityResolveResult | null,
> {
  readonly identityResolveResult: TIdentityResolveResult;
  readonly fusedResolveResult: EntityResolveResult;
}

export interface SearchRouteExecutionResultBase<
  TExecutionTopology extends ExecutionTopology = ExecutionTopology,
  TIdentityResolveResult extends EntityResolveResult | null = EntityResolveResult | null,
  TIdentityArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
  TGeneralArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
  TFusedArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
> extends SearchExecutionResolveSet<TIdentityResolveResult> {
  readonly executedCompiled: CompiledWineQuery;
  readonly executionTopology: TExecutionTopology;
  readonly laneArtifacts: SearchExecutionLaneArtifacts<
    TIdentityArtifact,
    TGeneralArtifact,
    TFusedArtifact
  >;
  readonly laneTrace: ExecutionLaneTrace;
  readonly rankedResults: readonly RankedResult[];
  readonly effectiveRetrievalMode: ExecutionRetrievalMode;
  readonly retrievalKind: SearchRouteRetrievalKind;
  readonly sparseExecuted: boolean;
  readonly specializedRouteExecuted: SpecializedRouteName | null;
  readonly usedCompiledExecution: boolean;
  readonly decisionContext?: SearchRouteDecisionContext | undefined;
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly fallbackReason?: string | undefined;
  readonly funnelMetrics?: FunnelMetrics | undefined;
  readonly rankingMetadata?: RankingMetadata | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
  /** E4: RRF fusion trace from the candidate pool, when hybrid RRF path was used. */
  readonly retrievalFusionTrace?: RrfFusionTrace | undefined;
  /** E4: Hard-filter drop log from the candidate pool, when hybrid RRF path was used. */
  readonly hardFilterDropLog?: readonly CandidateDropRecord[] | undefined;
  /** TA5: Calibrated posterior confidence from corrective retry, when accepted. */
  readonly correctiveRetryCalibration?: number | undefined;
  /**
   * ADR-015 Axis 2: rewrites + exhaustion signal from the executor-internal
   * critic loop. Absent when the `RETRIEVAL_EXECUTOR_CRITIC` flag was off
   * or the route bypassed the generic hybrid retrieval path.
   */
  readonly criticRewrites?: readonly DecisionInputCriticRewrite[] | undefined;
  readonly criticRetriesExhausted?: boolean | undefined;
}

export type EntityRouteResult = SearchRouteExecutionResultBase<
  'entity_only',
  EntityResolveResult
> & {
  readonly dualLaneExecutionAttemptId?: never;
};

export type GeneralOnlyRouteResult = SearchRouteExecutionResultBase<
  'general_only'
> & {
  readonly dualLaneExecutionAttemptId?: never;
};

export type DualLaneRouteResult = SearchRouteExecutionResultBase<
  'dual_lane',
  EntityResolveResult
> & {
  readonly dualLaneExecutionAttemptId: string;
};

export type SearchRouteExecutionResult =
  | EntityRouteResult
  | GeneralOnlyRouteResult
  | DualLaneRouteResult;

export function buildEmptySearchExecutionLaneArtifacts<
  TIdentityArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
  TGeneralArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
  TFusedArtifact extends SearchExecutionLaneArtifactRef = SearchExecutionLaneArtifactRef,
>(): SearchExecutionLaneArtifacts<TIdentityArtifact, TGeneralArtifact, TFusedArtifact> {
  return {
    identity: [],
    general: [],
    fused: [],
  };
}

export function buildSearchExecutionLaneTrace(params: {
  readonly executionTopology: ExecutionTopology;
  readonly identityResolveResult: EntityResolveResult | null;
  readonly fusedResolveResult: EntityResolveResult;
  readonly laneArtifacts: SearchExecutionLaneArtifacts;
}): ExecutionLaneTrace {
  const { executionTopology, identityResolveResult, fusedResolveResult, laneArtifacts } = params;
  const identityParticipated =
    identityResolveResult !== null
    || executionTopology === 'entity_only'
    || executionTopology === 'dual_lane';
  const generalParticipated =
    executionTopology === 'general_only' || executionTopology === 'dual_lane';
  const fusedParticipated = executionTopology !== 'entity_only';

  return {
    identity: {
      participated: identityParticipated,
      artifactCount: laneArtifacts.identity.length,
      ...(identityResolveResult !== null ? { resolveStatus: identityResolveResult.status } : {}),
    },
    general: {
      participated: generalParticipated,
      artifactCount: laneArtifacts.general.length,
    },
    fused: {
      participated: fusedParticipated,
      artifactCount: fusedParticipated ? laneArtifacts.fused.length : 0,
      ...(fusedParticipated ? { resolveStatus: fusedResolveResult.status } : {}),
    },
  };
}

/**
 * Central switch for entity / hybrid / mixed execution — keeps {@link SearchUseCase.execute} linear.
 */
export async function dispatchSearchRouteExecution(
  effectiveRoute: QueryRoute,
  actions: {
    readonly executeEntity: () => Promise<EntityRouteResult>;
    readonly executeHybrid: () => Promise<SearchRouteExecutionResult>;
    readonly executeMixed: () => Promise<SearchRouteExecutionResult>;
  },
): Promise<SearchRouteExecutionResult> {
  pipelineDebug(
    { step: PipelineDebugStep.DISPATCH_ROUTE, effective_route: effectiveRoute },
    'pipeline dispatch',
  );
  switch (effectiveRoute) {
    case 'entity': {
      const entityRoute = await actions.executeEntity();
      const rankedResults = entityRoute.rankedResults;
      pipelineDebug(
        {
          step: PipelineDebugStep.DISPATCH_ENTITY_COMPLETE,
          resolve_status: entityRoute.fusedResolveResult.status,
          ranked_count: rankedResults.length,
        },
        'pipeline dispatch entity complete',
      );
      return {
        ...entityRoute,
        ...(entityRoute.fusedResolveResult.degradation?.reasons.length
          ? {
              routeDegradation: {
                executionMode: 'degraded',
                degradationReasons: [...entityRoute.fusedResolveResult.degradation.reasons],
              },
            }
          : {}),
      };
    }
    case 'hybrid': {
      const hybridResult = await actions.executeHybrid();
      pipelineDebug(
        {
          step: PipelineDebugStep.DISPATCH_HYBRID_COMPLETE,
          resolve_status: hybridResult.fusedResolveResult.status,
          ranked_count: hybridResult.rankedResults.length,
        },
        'pipeline dispatch hybrid complete',
      );
      return hybridResult;
    }
    case 'mixed': {
      const mixedResult = await actions.executeMixed();
      pipelineDebug(
        {
          step: PipelineDebugStep.DISPATCH_MIXED_COMPLETE,
          resolve_status: mixedResult.fusedResolveResult.status,
          ranked_count: mixedResult.rankedResults.length,
        },
        'pipeline dispatch mixed complete',
      );
      return mixedResult;
    }
    default: {
      const _exhaustive: never = effectiveRoute;
      throw new Error(`Unhandled search route: ${String(_exhaustive)}`);
    }
  }
}
