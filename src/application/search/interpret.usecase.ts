import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../infrastructure/observability/query-entry-security-metrics.js';
import type { QueryPlannerPort } from './port/search-pipeline-deps.port.js';
import type { InterpretRequest } from './interpret-request.dto.js';
import type { InterpretResponseV2 } from '../../domain/response/model/result-item-v2.js';
import { buildPlannerContextFromSearchRequest } from './search-usecase-planner-context.js';
import { createSearchQuerySecurityGate } from './search-usecase-security-gate.js';
import { buildInterpretResponseV2 } from './interpret-explain-adapter-v2.js';
import { planToObservabilitySlice } from '../../domain/query/model/query-observability-vocab.js';

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
 * Result type when V2 explain contract is requested alongside the V1 plan.
 */
export interface InterpretResultWithV2 {
  readonly v1Plan: QueryPlanV1;
  readonly v2Explain: InterpretResponseV2;
}

/**
 * Interpret use case — runs QueryPlanner only and returns the QueryPlanV1
 * without executing any downstream pipeline stages.
 *
 * Useful for debugging and understanding how the planner interprets a query.
 *
 * When `buildV2` is true, also returns a V2 explain contract via
 * `InterpretResultWithV2`. The V1 plan is unchanged in both paths.
 */
export class InterpretUseCase {
  constructor(private readonly deps: InterpretUseCaseDeps) {}

  async execute(request: InterpretRequest & { readonly buildV2?: boolean }): Promise<QueryPlanV1>;
  async execute(request: InterpretRequest & { readonly buildV2: true }): Promise<InterpretResultWithV2>;
  async execute(
    request: InterpretRequest & { readonly buildV2?: boolean },
  ): Promise<QueryPlanV1 | InterpretResultWithV2> {
    const securityGate = createSearchQuerySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
      judgeFailureMode: this.deps.judgeFailureMode,
      queryEntrySecurityObserver: this.deps.queryEntrySecurityObserver,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

    const plan = await this.deps.queryPlanner.plan(
      effectiveQuery,
      buildPlannerContextFromSearchRequest({
        query: effectiveQuery,
        context: request.context,
        sessionContext: request.sessionContext,
        queryBudget: request.queryBudget,
      }),
    );

    if (request.buildV2 !== true) {
      return plan;
    }

    const queryId = `interpret-${Date.now()}`;
    const observabilitySlice = planToObservabilitySlice(queryId, plan);

    const v2Explain = buildInterpretResponseV2({
      queryId,
      queryText: effectiveQuery,
      observabilitySlice,
      decompositionHint: plan.decompositionHint,
      activeChannels: [],
    });

    return { v1Plan: plan, v2Explain };
  }
}
