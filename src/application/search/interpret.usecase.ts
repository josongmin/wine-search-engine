import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { PlannerContext } from '../../domain/query/service/planner.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryPlannerPort } from './port/search-pipeline-deps.port.js';
import type { InterpretRequest } from './interpret-request.dto.js';
import { QueryEntrySecurityGate } from './query-entry-security.js';

export type { InterpretRequest } from './interpret-request.dto.js';

/**
 * Dependencies injected into the InterpretUseCase.
 */
export interface InterpretUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  /** Shared public query entry guard: Layer 1 sanitizer is required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). */
  readonly injectionJudge?: InjectionJudgePort | undefined;
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
    const securityGate = new QueryEntrySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

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

    return this.deps.queryPlanner.plan(effectiveQuery, plannerContext);
  }
}
