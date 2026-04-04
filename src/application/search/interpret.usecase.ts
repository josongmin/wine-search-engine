import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { PlannerContext, Planner } from '../../domain/query/service/planner.js';
import type { EntityId } from '../../domain/shared/types/index.js';

/**
 * Interpret request — just the query plus optional context.
 */
export interface InterpretRequest {
  readonly query: string;
  readonly context?: {
    readonly locale: string;
    readonly currency: string;
  } | undefined;
  readonly sessionContext?: {
    readonly sessionId: string;
    readonly previousEntities: string[];
  } | undefined;
  readonly queryBudget?: {
    readonly maxLatencyMs: number;
    readonly maxCandidates: number;
    readonly rerankLimit: number;
  } | undefined;
}

/**
 * Dependencies injected into the InterpretUseCase.
 */
export interface InterpretUseCaseDeps {
  readonly queryPlanner: Planner;
}

/**
 * Interpret use case — runs QueryPlanner only and returns the QueryPlanV1
 * without executing any downstream pipeline stages.
 *
 * Useful for debugging and understanding how the planner interprets a query.
 */
export class InterpretUseCase {
  constructor(private readonly deps: InterpretUseCaseDeps) {}

  async execute(request: InterpretRequest): Promise<QueryPlanV1> {
    const plannerContext: PlannerContext = {
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
    };

    return this.deps.queryPlanner.plan(request.query, plannerContext);
  }
}
