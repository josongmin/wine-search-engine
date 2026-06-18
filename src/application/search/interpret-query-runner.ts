import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { QueryEntrySecurityObserver } from '../../domain/security/port/security-observer.port.js';
import type { QueryPlannerPort } from './port/search-pipeline-deps.port.js';
import type { InterpretRequest } from './interpret-request.dto.js';
import type { InterpretResponseV2 } from './interpret-response.dto.js';
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

export interface InterpretQueryRunnerDeps {
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

export interface InterpretQueryRunner {
  execute(
    request: InterpretRequest & { readonly buildV2: true; readonly requestId?: string | undefined },
    options?: RequestExecutionContext,
  ): Promise<InterpretResultWithV2>;
  execute(
    request: InterpretRequest & { readonly buildV2?: boolean | undefined; readonly requestId?: string | undefined },
    options?: RequestExecutionContext,
  ): Promise<QueryPlanV1 | InterpretResultWithV2>;
}

function requireCompiledForV2(
  deps: InterpretQueryRunnerDeps,
  plan: QueryPlanV1,
): CompiledWineQuery {
  if (deps.allowCompiledFallbackForTests === true) {
    return compileFromLegacyPlan(plan);
  }

  throw new Error(
    'Interpret query runner requires QueryPlanner.planWithCompiled() when buildV2 is requested',
  );
}

/**
 * Eval/integration-only planner trace — runs QueryPlanner without retrieval/ranking.
 *
 * No live HTTP route or production Container port after the V2 cutover.
 */
export async function runInterpretQuery(
  deps: InterpretQueryRunnerDeps,
  request: InterpretRequest & { readonly buildV2?: boolean | undefined; readonly requestId?: string | undefined },
  options?: RequestExecutionContext,
): Promise<QueryPlanV1 | InterpretResultWithV2> {
  throwIfAborted(options?.abortSignal, 'Interpret query runner aborted');

  const securityGate = createSearchQuerySecurityGate({
    querySanitizer: deps.querySanitizer,
    injectionJudge: deps.injectionJudge,
    judgeFailureMode: deps.judgeFailureMode,
    judgeTimeoutMs: deps.judgeTimeoutMs,
    queryEntrySecurityObserver: deps.queryEntrySecurityObserver,
  });
  const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

  throwIfAborted(options?.abortSignal, 'Interpret query runner aborted');

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
  if (deps.queryPlanner.planWithCompiled !== undefined) {
    const result = await deps.queryPlanner.planWithCompiled(effectiveQuery, plannerContext);
    plan = result.v1;
    compiled = result.compiled;
  } else {
    plan = await deps.queryPlanner.plan(effectiveQuery, plannerContext);
  }

  throwIfAborted(options?.abortSignal, 'Interpret query runner aborted');

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

  compiled ??= requireCompiledForV2(deps, plan);

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

export function buildInterpretQueryRunner(deps: InterpretQueryRunnerDeps): InterpretQueryRunner {
  const execute = ((
    request: InterpretRequest & { readonly buildV2?: boolean | undefined; readonly requestId?: string | undefined },
    options?: RequestExecutionContext,
  ) => runInterpretQuery(deps, request, options)) as InterpretQueryRunner['execute'];

  return { execute };
}
