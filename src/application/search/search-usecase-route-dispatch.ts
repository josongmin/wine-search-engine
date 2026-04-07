import { PipelineDebugStep } from '../../observability/pipeline-debug-steps.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { FunnelMetrics } from '../../domain/ranking/model/ranking-stage.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { RankingDegradationSignal } from '../../domain/ranking/model/ranking-runtime-signal.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { SpecializedRouteObservability } from './specialized-route-observability.js';

export interface SearchRouteDecisionContext {
  readonly mixedAnchor?: {
    readonly entityId: EntityId;
    readonly canonicalLabel: string;
    readonly confidence: number;
  } | undefined;
}

export interface SearchRouteExecutionResult {
  readonly resolveResult: EntityResolveResult;
  readonly rankedResults: readonly RankedResult[];
  readonly decisionContext?: SearchRouteDecisionContext | undefined;
  readonly routeDegradation?: RankingDegradationSignal | undefined;
  readonly fallbackReason?: string | undefined;
  readonly funnelMetrics?: FunnelMetrics | undefined;
  readonly specializedRouteObservability?: SpecializedRouteObservability | undefined;
}

/**
 * Central switch for entity / hybrid / mixed execution — keeps {@link SearchUseCase.execute} linear.
 */
export async function dispatchSearchRouteExecution(
  effectiveRoute: QueryRoute,
  actions: {
    readonly executeEntity: () => Promise<EntityResolveResult>;
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
      const resolveResult = await actions.executeEntity();
      pipelineDebug(
        {
          step: PipelineDebugStep.DISPATCH_ENTITY_COMPLETE,
          resolve_status: resolveResult.status,
          ranked_count: 0,
        },
        'pipeline dispatch entity complete',
      );
      return {
        resolveResult,
        rankedResults: [],
        ...(resolveResult.degradation?.reasons.length
          ? {
              routeDegradation: {
                executionMode: 'degraded',
                degradationReasons: [...resolveResult.degradation.reasons],
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
