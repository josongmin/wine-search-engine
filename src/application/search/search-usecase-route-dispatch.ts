import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { FunnelMetrics } from '../../domain/ranking/model/ranking-stage.js';

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
  /**
   * T5.6: Funnel metrics from the ranking pipeline, when available.
   * Populated by RankingStagePipeline; absent for plain Ranker or entity-only routes.
   */
  readonly funnelMetrics?: FunnelMetrics | undefined;
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
  switch (effectiveRoute) {
    case 'entity': {
      const resolveResult = await actions.executeEntity();
      return { resolveResult, rankedResults: [] };
    }
    case 'hybrid':
      return actions.executeHybrid();
    case 'mixed':
      return actions.executeMixed();
  }
}
