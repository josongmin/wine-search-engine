import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';

export interface SearchRouteExecutionResult {
  readonly resolveResult: EntityResolveResult;
  readonly rankedResults: readonly RankedResult[];
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
