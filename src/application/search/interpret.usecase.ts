import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../domain/security/port/security-observer.port.js';
import type { QueryPlannerPort } from './port/search-pipeline-deps.port.js';
import type { InterpretRequest } from './interpret-request.dto.js';
import type { InterpretResponseV2 } from '../../interface/http/schemas/search-response-v2.schema.js';
import { buildPlannerContextFromSearchRequest } from './search-usecase-planner-context.js';
import { createSearchQuerySecurityGate } from './search-usecase-security-gate.js';
import { compileFromLegacyPlan } from './search-usecase-compiled-fallback.js';
import { buildInterpretResponseV2 } from './interpret-explain-adapter-v2.js';
import { planToObservabilitySlice } from '../../domain/query/model/query-observability-vocab.js';
import { RetrievalProfileService } from '../../domain/retrieval/service/retrieval-profile.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../domain/observability/request-pipeline-debug.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { throwIfAborted } from '../../domain/shared/cooperative-abort.js';

const retrievalProfileService = new RetrievalProfileService();

/**
 * Dependencies injected into the InterpretUseCase.
 */
interface InterpretUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  /** Shared public query entry guard: Layer 1 sanitizer is required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). */
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly judgeTimeoutMs?: number | undefined;
  readonly queryEntrySecurityObserver?: QueryEntrySecurityObserver | undefined;
  /**
   * Explicit test seam for legacy compiled fallback.
   * Production callers must keep this false/undefined and provide planWithCompiled.
   */
  readonly allowCompiledFallbackForTests?: boolean | undefined;
}

/**
 * Result type when V2 explain contract is requested alongside the V1 plan.
 */
export interface InterpretResultWithV2 {
  readonly v1Plan: QueryPlanV1;
  readonly v2Explain: InterpretResponseV2;
  /** Compiled execution contract for callers that need route/mode decisions (E1-U4). */
  readonly compiled: CompiledWineQuery;
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

  private requireCompiledForV2(plan: QueryPlanV1): CompiledWineQuery {
    if (this.deps.allowCompiledFallbackForTests === true) {
      return compileFromLegacyPlan(plan);
    }

    throw new Error(
      'Interpret use case requires QueryPlanner.planWithCompiled() when buildV2 is requested',
    );
  }

  async execute(
    request: InterpretRequest & { readonly buildV2?: boolean | undefined; readonly requestId?: string | undefined },
    options?: RequestExecutionContext,
  ): Promise<QueryPlanV1>;
  async execute(
    request: InterpretRequest & { readonly buildV2: true; readonly requestId?: string | undefined },
    options?: RequestExecutionContext,
  ): Promise<InterpretResultWithV2>;
  async execute(
    request: InterpretRequest & { readonly buildV2?: boolean | undefined; readonly requestId?: string | undefined },
    options?: RequestExecutionContext,
  ): Promise<QueryPlanV1 | InterpretResultWithV2> {
    throwIfAborted(options?.abortSignal, 'Interpret use case aborted');

    const securityGate = createSearchQuerySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
      judgeFailureMode: this.deps.judgeFailureMode,
      judgeTimeoutMs: this.deps.judgeTimeoutMs,
      queryEntrySecurityObserver: this.deps.queryEntrySecurityObserver,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

    throwIfAborted(options?.abortSignal, 'Interpret use case aborted');

    const plannerContext = buildPlannerContextFromSearchRequest(
      {
        query: effectiveQuery,
        context: request.context,
        sessionContext: request.sessionContext,
        queryBudget: request.queryBudget,
      },
      {
        ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
        ...(options?.debugRequest === true ? { debugRequest: true } : {}),
      },
    );

    let plan: QueryPlanV1;
    let compiled: CompiledWineQuery | undefined;
    if (this.deps.queryPlanner.planWithCompiled !== undefined) {
      const result = await this.deps.queryPlanner.planWithCompiled(effectiveQuery, plannerContext);
      plan = result.v1;
      compiled = result.compiled;
    } else {
      plan = await this.deps.queryPlanner.plan(effectiveQuery, plannerContext);
    }

    throwIfAborted(options?.abortSignal, 'Interpret use case aborted');

    pipelineDebug(
      {
        step: 'interpret.planner.done',
        query_class: plan.queryClass,
        route: plan.route,
        retrieval_mode: plan.retrievalMode,
        ...(compiled !== undefined
          ? {
              compiled_route: compiled.execution.effectiveRoute,
              compiled_mode: compiled.execution.effectiveRetrievalMode,
            }
          : {}),
        query_preview: sanitizeQueryForDebug(effectiveQuery),
        build_v2: request.buildV2 === true,
      },
      'pipeline interpret',
    );

    if (request.buildV2 !== true) {
      return plan;
    }

    compiled ??= this.requireCompiledForV2(plan);

    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string after trim should fall through to generated ID
    const queryId = request.requestId?.trim() || `interpret-${Date.now()}`;
    const observabilitySlice = planToObservabilitySlice(queryId, plan, compiled);
    const activeChannels = retrievalProfileService.getExecutionChannelMix(
      plan.queryClass,
      compiled.execution.effectiveRoute,
      compiled.execution.effectiveRetrievalMode,
    );

    const v2Explain = buildInterpretResponseV2({
      queryId,
      queryText: effectiveQuery,
      observabilitySlice,
      decompositionHint: plan.decompositionHint,
      activeChannels,
      hardConstraints: plan.constraints.hard,
      softConstraints: plan.constraints.soft,
    });

    return { v1Plan: plan, v2Explain, compiled };
  }
}
