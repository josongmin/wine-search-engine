import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import { analyzeQueryDecomposition, isValidDecomposition } from '../../domain/query/service/decomposition-detector.js';
import type { QueryPlannerPort } from './port/search-pipeline-deps.port.js';
import type { ResponseBuilderPort } from './port/search-pipeline-deps.port.js';
import type { DecomposedSearchUseCasePort } from './port/search-route-usecases.port.js';
import type { SearchRequest } from './search-request.dto.js';
import { buildConstraintContradictionExitParams } from './search-usecase-constraint-early-exit.js';
import { mergeCachedSearchResponseMeta } from './search-usecase-cache-hit.js';
import { tryGetCachedSearchResponse } from './search-usecase-cache-lookup.js';
import type { CacheLookupRuntimeState, SnapshotVersionInjection } from './search-usecase-cache-lookup.js';
import { buildPlannerContextFromSearchRequest } from './search-usecase-planner-context.js';
import { createSearchQuerySecurityGate, type SearchSecurityGateDeps } from './search-usecase-security-gate.js';
import { logSearchEvent } from '../../observability/log-search-event.js';
import { pipelineDebug } from '../../observability/request-pipeline-debug.js';
import { planToObservabilitySlice } from '../../domain/query/model/query-observability-vocab.js';
import { compileFromLegacyPlan } from './search-usecase-compiled-fallback.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { buildAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';

export type SearchPreRouteEarlyResponse = SearchResponseV1 | ComparisonSearchResponse;

export type SearchPreRoutePhaseResult =
  | { readonly outcome: 'continue'; readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery }
  | { readonly outcome: 'return'; readonly response: SearchPreRouteEarlyResponse };

export interface SearchPreRoutePhaseContext extends RequestExecutionContext {
  readonly request: SearchRequest;
  /** When set, forwarded into {@link PlannerContext.abortSignal} (NL / LLM constraint path). */
  readonly requestId: string;
  readonly startTime: number;
  readonly snapshotVersions: SnapshotVersionInjection;
  readonly securityGateDeps: SearchSecurityGateDeps;
  readonly queryPlanner: QueryPlannerPort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly constraintSAT: ConstraintSAT;
  readonly cacheService?: SearchResponseCachePort | undefined;
  readonly cacheLookupRuntimeState?: CacheLookupRuntimeState | undefined;
  readonly decomposedSearch?: DecomposedSearchUseCasePort | undefined;
}

/**
 * Sanitize → optional Epic 14 comparison → plan → constraint-SAT → optional cache hit.
 */
export async function runSearchPreRoutePhase(
  ctx: SearchPreRoutePhaseContext,
): Promise<SearchPreRoutePhaseResult> {
  const sanitizedQuery = ctx.executionPrincipal === 'benchmark_trusted'
    ? ctx.request.query
    : await createSearchQuerySecurityGate(ctx.securityGateDeps).getSafeQueryOrThrow(ctx.request.query);

  if (ctx.decomposedSearch) {
    const decomposition = analyzeQueryDecomposition(sanitizedQuery);
    if (isValidDecomposition(decomposition.outcome)) {
      const DECOMPOSED_SEARCH_TIMEOUT_MS = 15_000;
      const timeoutSignal = Symbol('timeout');
      const abortController = new AbortController();
      const decomposedAbortSignal =
        ctx.abortSignal !== undefined
          ? AbortSignal.any([ctx.abortSignal, abortController.signal])
          : abortController.signal;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<typeof timeoutSignal>((resolve) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          resolve(timeoutSignal);
        }, DECOMPOSED_SEARCH_TIMEOUT_MS);
      });
      const decomposedSearchPromise = ctx.decomposedSearch.execute(
        decomposition.outcome.subQueries,
        decomposition.outcome.comparisonIntent,
        sanitizedQuery,
        ctx.requestId,
        ctx.startTime,
        {
          ...(ctx.request.context !== undefined ? { context: ctx.request.context } : {}),
          ...(ctx.request.sessionContext !== undefined
            ? { sessionContext: ctx.request.sessionContext }
            : {}),
          ...(ctx.request.queryBudget !== undefined ? { queryBudget: ctx.request.queryBudget } : {}),
          // Forward explain so a comparison-route caller (options.explain=true)
          // gets counterfactuals on both sub-search legs.
          ...(ctx.request.options?.explain === true ? { explain: true } : {}),
        },
        { abortSignal: decomposedAbortSignal },
      ).catch((err: unknown) => {
        // After timeout fires we abort the controller. Any subsequent rejection
        // — AbortError, HTTP 5xx from in-flight sub-search, planner crash —
        // would otherwise become an unhandledRejection because nothing is
        // awaiting the inner promise post-race. Swallow ALL errors after abort.
        if (abortController.signal.aborted) {
          return timeoutSignal;
        }
        throw err;
      });
      let decomposedResponse: typeof timeoutSignal | ComparisonSearchResponse;
      try {
        decomposedResponse = await Promise.race([
          decomposedSearchPromise,
          timeoutPromise,
        ]) as typeof timeoutSignal | ComparisonSearchResponse;
      } finally {
        // Always clear the timeout handle — prevents timer leak when
        // decomposedSearchPromise rejects before the timeout fires.
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        // Abort any in-flight sub-search work (network requests, sub-use-case
        // execution) so it does not continue running after we have moved on.
        // Calling abort() on an already-aborted or completed controller is a no-op.
        abortController.abort();
      }
      if (decomposedResponse === timeoutSignal) {
        pipelineDebug(
          {
            step: 'pre_route.decomposed_comparison',
            decomposition_strategy: decomposition.hint.strategy,
            timed_out: true,
          },
          'pipeline pre_route decomposed search timed out — continuing without decomposition',
        );
      } else if (typeof decomposedResponse !== 'symbol') {
        const response = decomposedResponse;
        logSearchEvent({
          runtime_correlation_ref: ctx.requestId,
          decomposition_strategy: decomposition.hint.strategy,
        });
        pipelineDebug(
          {
            step: 'pre_route.decomposed_comparison',
            decomposition_strategy: decomposition.hint.strategy,
          },
          'pipeline pre_route comparison branch',
        );
        return { outcome: 'return', response };
      }
    }
  }

  // Use planWithCompiled when available (PlannerV1Adapter implements this).
  // Falls back to plan() + local ExecutionCompiler for adapters that only implement the base port.
  const plannerContext = buildPlannerContextFromSearchRequest(ctx.request, {
    ...(ctx.abortSignal !== undefined ? { abortSignal: ctx.abortSignal } : {}),
  });
  let plan: QueryPlanV1;
  let compiled: CompiledWineQuery;
  if (ctx.queryPlanner.planWithCompiled !== undefined) {
    const result = await ctx.queryPlanner.planWithCompiled(sanitizedQuery, plannerContext);
    plan = result.v1;
    compiled = result.compiled;
  } else {
    plan = await ctx.queryPlanner.plan(sanitizedQuery, plannerContext);
    compiled = compileFromLegacyPlan(plan);
    pipelineDebug(
      {
        step: 'pre_route.plan_compiled_fallback',
        note: 'planWithCompiled unavailable — using V1→V2 reconstruction',
        plan_route: plan.route,
        compiled_route: compiled.execution.effectiveRoute,
      },
      'pipeline pre_route compiled fallback',
    );
  }

  // Merge caller-supplied structured filters (from agent tools / batch API)
  // into the planner's hard constraints so they flow to Vespa as YQL filters.
  //
  // Override semantics (SOTA best practice — Multi-Meta-RAG pattern):
  //   Structured params from the agent are AUTHORITATIVE and override NL-extracted
  //   constraints on the same attribute. This prevents noisy NL extraction from
  //   conflicting with the agent's explicit intent. For example, if the agent passes
  //   wine_type="red" AND the NL planner also extracted wine_type="red" from the
  //   enriched query, we keep the agent version (same result). But if the planner
  //   extracts wine_type="white" from a confusing enriched query, the agent's
  //   explicit wine_type="red" replaces it.
  //
  //   Override applies per (attribute, operator) pair — so agent's exclude_grapes
  //   replaces any NL-extracted exclude for the same attribute, but does NOT
  //   override a different attribute like wine_type.
  if (ctx.request.filters !== undefined && ctx.request.filters.length > 0) {
    // Attributes covered by structured agent filters (operator-aware override).
    // For 'exclude'/'not_in' operators, override only same-operator NL constraints.
    const agentCoveredKeys = new Set(
      ctx.request.filters.map((f) => `${f.attribute}:${f.operator}`),
    );
    // Drop NL-extracted constraints that are overridden by agent structured params.
    // Exact-match on (attribute, operator) — same attribute with different operator
    // (e.g. NL extracted region='=' and agent passed region='exclude') coexist.
    const nonOverridden = plan.constraints.hard.filter(
      (c) => !agentCoveredKeys.has(`${c.attribute}:${c.operator}`),
    );
    plan = {
      ...plan,
      constraints: {
        ...plan.constraints,
        hard: [...nonOverridden, ...ctx.request.filters],
      },
    };
  }

  logSearchEvent({
    runtime_correlation_ref: ctx.requestId,
    query_observability: planToObservabilitySlice(ctx.requestId, plan, compiled),
    ...(plan.decompositionHint !== undefined
      ? { decomposition_strategy: plan.decompositionHint.strategy }
      : {}),
  });

  const satResult = ctx.constraintSAT.check(plan.constraints);
  if (satResult.contradicted) {
    pipelineDebug(
      {
        step: 'pre_route.constraint_contradiction',
        query_class: plan.queryClass,
        conflict_pairs: satResult.conflictPairs.length,
      },
      'pipeline pre_route constraint exit',
    );
    let response: SearchResponseV1;
    try {
      response = ctx.responseBuilder.build(
        buildConstraintContradictionExitParams(
          plan,
          ctx.request,
          ctx.requestId,
          ctx.startTime,
          ctx.snapshotVersions,
          satResult.conflictPairs,
          compiled,
        ),
      );
    } catch (buildErr) {
      bootstrapLogger.warn(
        { requestId: ctx.requestId, err: buildErr },
        '[runSearchPreRoutePhase] responseBuilder.build() threw in constraint-contradiction exit; returning bare safe response',
      );
      const queryTimeMs = Date.now() - ctx.startTime;
      const safeSnapshot = buildDecisionSnapshotFromPlan(plan, ctx.snapshotVersions);
      const effectiveRoute = compiled.execution.effectiveRoute;
      const safeTraceRef = buildAuthorityTraceRef({
        queryPlan: plan,
        snapshot: safeSnapshot,
        route: effectiveRoute,
        retrievalMode: compiled.execution.effectiveRetrievalMode,
        decisionStatus: 'failed',
        nextAction: 'fail',
        failureReason: 'HARD_CONSTRAINT_VIOLATION',
      });
      response = {
        queryType: 'search',
        engineDecision: {
          decisionStatus: 'failed',
          nextAction: 'fail',
          route: effectiveRoute,
          decisionConfidence: 0,
          confidenceSemantics: 'calibrated_decision_confidence',
          decisionTraceRef: safeTraceRef,
          authorityTraceRef: safeTraceRef,
          decisionSnapshot: safeSnapshot,
        },
        results: [],
        meta: {
          requestId: ctx.requestId,
          queryTimeMs,
          route: effectiveRoute,
          version: '1.0.0',
          engine_schema_version: 'search_response_v1',
          authorityTraceRef: safeTraceRef,
          runtimeCorrelationRef: ctx.requestId,
          executionMode: 'degraded',
          blockingEligible: false,
        },
      };
    }
    return { outcome: 'return', response };
  }

  if (ctx.cacheService) {
    const cached = await tryGetCachedSearchResponse(
      ctx.cacheService,
      plan,
      compiled,
      ctx.request,
      ctx.snapshotVersions,
      ctx.cacheLookupRuntimeState,
      ctx.requestId,
    );
    if (cached !== undefined) {
      pipelineDebug(
        {
          step: 'pre_route.cache_hit',
          query_class: plan.queryClass,
        },
        'pipeline pre_route cache hit',
      );
      const response = mergeCachedSearchResponseMeta(
        cached,
        ctx.requestId,
        ctx.startTime,
      );
      return { outcome: 'return', response };
    }
  }

  pipelineDebug(
    {
      step: 'pre_route.continue',
      query_class: plan.queryClass,
      plan_route: plan.route,
      compiled_route: compiled.execution.effectiveRoute,
      compiled_mode: compiled.execution.effectiveRetrievalMode,
    },
    'pipeline pre_route plan ready',
  );

  return { outcome: 'continue', plan, compiled };
}
