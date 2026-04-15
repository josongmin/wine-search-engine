import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { ExecutionRetrievalMode } from '../../domain/query/model/engine-execution-contract.js';
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

export interface SearchRouteExecutionResult {
  readonly resolveResult: EntityResolveResult;
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

/**
 * Minimal entity route result — wraps EntityResolveResult with optional TA5 calibration.
 */
export interface EntityRouteResult {
  readonly resolveResult: EntityResolveResult;
  /** Entity route synthetic ranked results built from resolver output + entity docs. */
  readonly rankedResults: readonly RankedResult[];
  readonly effectiveRetrievalMode: ExecutionRetrievalMode;
  readonly retrievalKind: SearchRouteRetrievalKind;
  readonly sparseExecuted: boolean;
  readonly specializedRouteExecuted: SpecializedRouteName | null;
  readonly usedCompiledExecution: boolean;
  /** TA5: Calibrated posterior confidence from corrective retry, when accepted. */
  readonly correctiveRetryCalibration?: number | undefined;
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
      const {
        resolveResult,
        correctiveRetryCalibration,
        effectiveRetrievalMode,
        retrievalKind,
        sparseExecuted,
        specializedRouteExecuted,
        usedCompiledExecution,
      } = entityRoute;
      const rankedResults = entityRoute.rankedResults;
      pipelineDebug(
        {
          step: PipelineDebugStep.DISPATCH_ENTITY_COMPLETE,
          resolve_status: resolveResult.status,
          ranked_count: rankedResults.length,
        },
        'pipeline dispatch entity complete',
      );
      return {
        resolveResult,
        rankedResults,
        effectiveRetrievalMode,
        retrievalKind,
        sparseExecuted,
        specializedRouteExecuted,
        usedCompiledExecution,
        ...(resolveResult.degradation?.reasons.length
          ? {
              routeDegradation: {
                executionMode: 'degraded',
                degradationReasons: [...resolveResult.degradation.reasons],
              },
            }
          : {}),
        ...(correctiveRetryCalibration !== undefined ? { correctiveRetryCalibration } : {}),
      };
    }
    case 'hybrid': {
      const hybridResult = await actions.executeHybrid();
      pipelineDebug(
        {
          step: PipelineDebugStep.DISPATCH_HYBRID_COMPLETE,
          resolve_status: hybridResult.resolveResult.status,
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
          resolve_status: mixedResult.resolveResult.status,
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
