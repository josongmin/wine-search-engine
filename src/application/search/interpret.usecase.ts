import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../infrastructure/observability/query-entry-security-metrics.js';
import type { QueryPlannerPort } from './port/search-pipeline-deps.port.js';
import type { InterpretRequest } from './interpret-request.dto.js';
import { buildPlannerContextFromSearchRequest } from './search-usecase-planner-context.js';
import { createSearchQuerySecurityGate } from './search-usecase-security-gate.js';

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
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly queryEntrySecurityObserver?: QueryEntrySecurityObserver | undefined;
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
    const securityGate = createSearchQuerySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
      judgeFailureMode: this.deps.judgeFailureMode,
      queryEntrySecurityObserver: this.deps.queryEntrySecurityObserver,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

    return this.deps.queryPlanner.plan(
      effectiveQuery,
      buildPlannerContextFromSearchRequest({
        query: effectiveQuery,
        context: request.context,
        sessionContext: request.sessionContext,
        queryBudget: request.queryBudget,
      }),
    );
  }
}
