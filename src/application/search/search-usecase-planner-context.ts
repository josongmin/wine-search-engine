import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import type { PlannerContext } from '../../domain/query/service/planner.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { SearchRequest } from './search-request.dto.js';

export type BuildPlannerContextOptions = RequestExecutionContext;

/**
 * Maps HTTP/application {@link SearchRequest} to domain {@link PlannerContext}.
 */
export function buildPlannerContextFromSearchRequest(
  request: SearchRequest,
  options?: BuildPlannerContextOptions,
): PlannerContext {
  return {
    locale: request.context?.locale,
    session: request.sessionContext
      ? {
          sessionId: request.sessionContext.sessionId,
          previousEntities: request.sessionContext.previousEntities as EntityId[],
        }
      : undefined,
    budget: request.queryBudget
      ? {
          maxLatencyMs: request.queryBudget.maxLatencyMs,
          maxCandidates: request.queryBudget.maxCandidates,
          rerankLimit: request.queryBudget.rerankLimit,
        }
      : undefined,
    ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
    ...((request.options?.explain === true || options?.debugRequest === true)
      ? { enablePlannerTrace: true }
      : {}),
  };
}
