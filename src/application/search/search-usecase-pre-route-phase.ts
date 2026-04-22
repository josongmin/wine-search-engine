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
import type { RepresentativeConceptSearchContext, SearchRequest } from './search-request.dto.js';
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
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../domain/retrieval/model/retrieval-objective.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { PolicyBlockedError } from '../../domain/shared/error/policy-blocked.js';

/** Hard timeout for decomposed (multi-sub-query) search execution. */
const DECOMPOSED_SEARCH_TIMEOUT_MS = 15_000;
const DECOMPOSED_SEARCH_MIN_TIMEOUT_MS = 1;
const STRUCTURED_SET_RETRIEVAL_PREFERENCE_ATTRIBUTES = new Set([
  'alcohol_pct',
  'beginner_suitability',
  'closure',
  'gift_suitability',
  'occasion',
  'popularity_score',
  'producer_prestige',
  'style',
]);
const STRUCTURED_SET_RETRIEVAL_FILTER_ATTRIBUTES = new Set([
  'appellation',
  'country',
  'grape_primary',
  'region',
  'wine_type',
]);
const STRUCTURED_RECOMMENDATION_DEFAULT_MAX_CANDIDATES = 20;
const STRUCTURED_RECOMMENDATION_DEFAULT_RERANK_LIMIT = 20;

type SearchPreRouteEarlyResponse = SearchResponseV1 | ComparisonSearchResponse;

type SearchPreRoutePhaseResult =
  | { readonly outcome: 'continue'; readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery }
  | { readonly outcome: 'return'; readonly response: SearchPreRouteEarlyResponse };

function normalizeRepresentativeValue(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    const normalized = value.normalize('NFKC').trim().toLowerCase();
    return normalized.length > 0 ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeRepresentativeValue(entry));
  }
  return [];
}

function constraintMatchesRepresentativeConcept(
  constraint: QueryPlanV1['constraints']['hard'][number],
  concept: RepresentativeConceptSearchContext,
): boolean {
  if (constraint.attribute !== concept.field) {
    return false;
  }
  const target = concept.value.normalize('NFKC').trim().toLowerCase();
  if (target.length === 0) {
    return false;
  }
  return normalizeRepresentativeValue(constraint.value).includes(target);
}

function representativeConstraintKey(
  constraint: QueryPlanV1['constraints']['hard'][number],
): string {
  return JSON.stringify([
    constraint.attribute,
    constraint.operator,
    constraint.value,
    constraint.source_phrase,
    constraint.mapping_version,
  ]);
}

function applyRepresentativeConceptContext(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  concept: RepresentativeConceptSearchContext | undefined,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  if (concept === undefined) {
    return { plan, compiled };
  }

  const representativeHard = plan.constraints.hard.filter((constraint) =>
    constraintMatchesRepresentativeConcept(constraint, concept),
  );
  if (representativeHard.length === 0) {
    return { plan, compiled };
  }

  const representativeKeys = new Set(representativeHard.map(representativeConstraintKey));
  const hard = plan.constraints.hard.filter((constraint) =>
    !representativeKeys.has(representativeConstraintKey(constraint)),
  );
  const existingSoftKeys = new Set(plan.constraints.soft.map(representativeConstraintKey));
  const demotedSoft = representativeHard.filter((constraint) =>
    !existingSoftKeys.has(representativeConstraintKey(constraint)),
  );
  const constraints = {
    ...plan.constraints,
    hard,
    soft: [...plan.constraints.soft, ...demotedSoft],
  };
  const admissionContext = {
    requires_identity_seal: plan.admission_context?.requires_identity_seal ?? false,
    requires_constraint_evidence: hard.length > 0,
    requires_anchor_evidence: plan.admission_context?.requires_anchor_evidence ?? false,
  } as const;
  const nextPlan: QueryPlanV1 = {
    ...plan,
    constraints,
    admission_context: admissionContext,
  };
  const nextCompiled: CompiledWineQuery = {
    query: {
      ...compiled.query,
      constraints,
      retrievalPlan: buildRetrievalPlan(constraints),
      retrievalObjective: buildRetrievalObjective(constraints),
    },
    execution: {
      ...compiled.execution,
      provenancePolicy: {
        ...compiled.execution.provenancePolicy,
        requireConstraintEvidence: admissionContext.requires_constraint_evidence,
      },
    },
    ...(compiled.plannerTrace !== undefined ? { plannerTrace: compiled.plannerTrace } : {}),
  };

  return { plan: nextPlan, compiled: nextCompiled };
}

function requestHasStructuredSetRetrievalPreference(
  request: SearchRequest,
): boolean {
  return (request.preferences ?? []).some((constraint) =>
    STRUCTURED_SET_RETRIEVAL_PREFERENCE_ATTRIBUTES.has(constraint.attribute),
  );
}

function requestHasStructuredSetRetrievalFilter(
  request: SearchRequest,
): boolean {
  return (request.filters ?? []).some((constraint) =>
    constraint.operator === '='
    && STRUCTURED_SET_RETRIEVAL_FILTER_ATTRIBUTES.has(constraint.attribute),
  );
}

function applyStructuredSetRetrievalContext(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  request: SearchRequest,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  if (
    compiled.execution.routeSource !== 'planner'
    || compiled.execution.effectiveRoute !== 'entity'
    || (
      !requestHasStructuredSetRetrievalPreference(request)
      && !requestHasStructuredSetRetrievalFilter(request)
    )
  ) {
    return { plan, compiled };
  }

  const maxCandidates =
    request.queryBudget?.maxCandidates
    ?? Math.max(STRUCTURED_RECOMMENDATION_DEFAULT_MAX_CANDIDATES, compiled.execution.budget.maxCandidates);
  const rerankLimit = Math.min(
    maxCandidates,
    request.queryBudget?.rerankLimit ?? STRUCTURED_RECOMMENDATION_DEFAULT_RERANK_LIMIT,
  );
  const admissionContext = {
    requires_identity_seal: false,
    requires_constraint_evidence: plan.admission_context?.requires_constraint_evidence ?? plan.constraints.hard.length > 0,
    requires_anchor_evidence: false,
  } as const;
  const nextPlan: QueryPlanV1 = {
    ...plan,
    route: 'hybrid',
    retrievalMode: 'recommendation',
    admission_context: admissionContext,
  };
  const nextCompiled: CompiledWineQuery = {
    ...compiled,
    execution: {
      ...compiled.execution,
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'recommendation',
      budget: {
        maxCandidates,
        rerankLimit,
        enablePrecisionRerank: true,
      },
      provenancePolicy: {
        ...compiled.execution.provenancePolicy,
        requireIdentitySeal: false,
        requireConstraintEvidence: admissionContext.requires_constraint_evidence,
        requireAnchorEvidence: false,
      },
    },
  };

  return { plan: nextPlan, compiled: nextCompiled };
}

function resolveDecomposedSearchTimeoutMs(
  request: SearchRequest,
  startTime: number,
  nowMs: number = Date.now(),
): number {
  const configuredBudgetMs = request.queryBudget?.maxLatencyMs;
  if (!Number.isFinite(configuredBudgetMs) || configuredBudgetMs === undefined) {
    return DECOMPOSED_SEARCH_TIMEOUT_MS;
  }

  const elapsedMs = Math.max(0, nowMs - startTime);
  const remainingBudgetMs = configuredBudgetMs - elapsedMs;
  if (remainingBudgetMs <= 0) {
    return 0;
  }

  return Math.max(
    DECOMPOSED_SEARCH_MIN_TIMEOUT_MS,
    Math.min(DECOMPOSED_SEARCH_TIMEOUT_MS, remainingBudgetMs),
  );
}

export interface SearchPreRoutePhaseContext extends RequestExecutionContext {
  readonly request: SearchRequest;
  /** When set, forwarded into {@link PlannerContext} (NL / LLM constraint path). */
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
  /**
   * Explicit test / special-seam escape hatch for plan-only planners.
   * Production search paths must provide planWithCompiled and should not rely on this.
   */
  readonly allowCompiledFallback?: boolean | undefined;
}

/**
 * Sanitize → optional Epic 14 comparison → plan → constraint-SAT → optional cache hit.
 */
export async function runSearchPreRoutePhase(
  ctx: SearchPreRoutePhaseContext,
): Promise<SearchPreRoutePhaseResult> {
  const runPreRouteCore = async (
    sanitizedQuery: string,
    plannerAbortSignal: AbortSignal | undefined,
  ): Promise<SearchPreRoutePhaseResult> => {
    if (ctx.decomposedSearch) {
      ctx.stageTimer?.start('pre_route.decomposition.detect');
      const decomposition = (() => {
        try {
          return analyzeQueryDecomposition(sanitizedQuery);
        } finally {
          ctx.stageTimer?.end('pre_route.decomposition.detect');
        }
      })();
      if (isValidDecomposition(decomposition.outcome)) {
        const decomposedSearchTimeoutMs = resolveDecomposedSearchTimeoutMs(
          ctx.request,
          ctx.startTime,
        );
        if (decomposedSearchTimeoutMs <= 0) {
          pipelineDebug(
            {
              step: 'pre_route.decomposed_comparison',
              decomposition_strategy: decomposition.hint.strategy,
              skipped_due_to_budget: true,
            },
            'pipeline pre_route decomposed search skipped due to exhausted request budget',
          );
        } else {
          const timeoutSignal = Symbol('timeout');
          const abortController = new AbortController();
          const decomposedAbortSignal =
            plannerAbortSignal !== undefined
              ? AbortSignal.any([plannerAbortSignal, abortController.signal])
              : abortController.signal;
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<typeof timeoutSignal>((resolve) => {
            timeoutHandle = setTimeout(() => {
              abortController.abort();
              resolve(timeoutSignal);
            }, decomposedSearchTimeoutMs);
          });
          ctx.stageTimer?.start('pre_route.decomposition.execute');
          const decomposedSearchPromise = ctx.decomposedSearch.execute(
            decomposition.outcome.subQueries,
            decomposition.outcome.comparisonLegs,
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
              ...(ctx.request.filters !== undefined && ctx.request.filters.length > 0
                ? { filters: ctx.request.filters }
                : {}),
              ...(ctx.request.preferences !== undefined && ctx.request.preferences.length > 0
                ? { preferences: ctx.request.preferences }
                : {}),
              // Forward explain so a comparison-route caller (options.explain=true)
              // gets counterfactuals on both sub-search legs.
              ...(ctx.request.options?.explain === true ? { explain: true } : {}),
            },
            {
              abortSignal: decomposedAbortSignal,
              ...(ctx.executionPrincipal !== undefined
                ? { executionPrincipal: ctx.executionPrincipal }
                : {}),
            },
          ).catch((err: unknown) => {
            // After timeout fires we abort the controller. Any subsequent rejection
            // — AbortError, HTTP 5xx from in-flight sub-search, planner crash —
            // would otherwise become an unhandledRejection because nothing is
            // awaiting the inner promise post-race. Swallow ALL errors after abort.
            if (abortController.signal.aborted) {
              return timeoutSignal;
            }
            throw err;
          }).finally(() => {
            ctx.stageTimer?.end('pre_route.decomposition.execute');
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
    }

    // Use planWithCompiled when available (PlannerV1Adapter implements this).
    // Falls back to plan() + local ExecutionCompiler for adapters that only implement the base port.
    const plannerContext = buildPlannerContextFromSearchRequest(ctx.request, {
      ...(plannerAbortSignal !== undefined ? { abortSignal: plannerAbortSignal } : {}),
      ...(ctx.debugRequest === true ? { debugRequest: true } : {}),
      ...(ctx.stageTimer !== undefined ? { stageTimer: ctx.stageTimer } : {}),
      requestId: ctx.requestId,
    });
    let plan: QueryPlanV1;
    let compiled: CompiledWineQuery;
    ctx.stageTimer?.start('pre_route.planner');
    if (ctx.queryPlanner.planWithCompiled !== undefined) {
      const result = await ctx.queryPlanner.planWithCompiled(
        sanitizedQuery,
        plannerContext,
      ).finally(() => {
        ctx.stageTimer?.end('pre_route.planner');
      });
      plan = result.v1;
      compiled = result.compiled;
    } else if (ctx.allowCompiledFallback === true) {
      plan = await ctx.queryPlanner.plan(
        sanitizedQuery,
        plannerContext,
      ).finally(() => {
        ctx.stageTimer?.end('pre_route.planner');
      });
      compiled = compileFromLegacyPlan(plan);
    } else {
      ctx.stageTimer?.end('pre_route.planner');
      throw new Error(
        'Search pre-route requires QueryPlanner.planWithCompiled(); ' +
        'set allowCompiledFallback=true only for tests or explicit special seams.',
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
    let structuredConstraintsMerged = false;
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
      structuredConstraintsMerged = true;
    }

    if (ctx.request.preferences !== undefined && ctx.request.preferences.length > 0) {
      const preferenceCoveredKeys = new Set(
        ctx.request.preferences.map((f) => `${f.attribute}:${f.operator}`),
      );
      const nonOverriddenSoft = plan.constraints.soft.filter(
        (c) => !preferenceCoveredKeys.has(`${c.attribute}:${c.operator}`),
      );
      plan = {
        ...plan,
        constraints: {
          ...plan.constraints,
          soft: [...nonOverriddenSoft, ...ctx.request.preferences],
        },
      };
      structuredConstraintsMerged = true;
    }

    if (structuredConstraintsMerged) {
      const admissionContext = {
        requires_identity_seal: plan.admission_context?.requires_identity_seal ?? false,
        requires_constraint_evidence: plan.constraints.hard.length > 0,
        requires_anchor_evidence: plan.admission_context?.requires_anchor_evidence ?? false,
      } as const;
      plan = {
        ...plan,
        admission_context: admissionContext,
      };
      compiled = {
        ...compiled,
        query: {
          ...compiled.query,
          constraints: plan.constraints,
          retrievalPlan: buildRetrievalPlan(plan.constraints),
          retrievalObjective: buildRetrievalObjective(plan.constraints),
        },
        execution: {
          ...compiled.execution,
          provenancePolicy: {
            ...compiled.execution.provenancePolicy,
            requireConstraintEvidence: admissionContext.requires_constraint_evidence,
          },
        },
      };
    }

    ({ plan, compiled } = applyRepresentativeConceptContext(
      plan,
      compiled,
      ctx.request.representativeConcept,
    ));

    ({ plan, compiled } = applyStructuredSetRetrievalContext(
      plan,
      compiled,
      ctx.request,
    ));

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
      // CLAUDE.md: catch blocks in use-case code MUST NOT fabricate
      // success-shaped responses from unexpected errors. If responseBuilder
      // throws here it is a programmer/infrastructure bug, not an enumerated
      // degradation — propagate to the HTTP error handler so the failure is
      // visible and the RFC-014 envelope is emitted by the central handler.
      const response = ctx.responseBuilder.build(
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
  };

  if (ctx.executionPrincipal === 'benchmark_trusted') {
    return runPreRouteCore(ctx.request.query, ctx.abortSignal);
  }

  const routeAbortController = new AbortController();
  const plannerAbortSignal =
    ctx.abortSignal !== undefined
      ? AbortSignal.any([ctx.abortSignal, routeAbortController.signal])
      : routeAbortController.signal;
  const securityGate = createSearchQuerySecurityGate(ctx.securityGateDeps);

  ctx.stageTimer?.start('pre_route.security_gate');
  try {
    const securityCheck = securityGate.startQuerySecurityCheck(ctx.request.query, {
      abortSignal: plannerAbortSignal,
    });
    if (securityCheck.layer1Rejection !== undefined) {
      throw new PolicyBlockedError(undefined, securityCheck.layer1Rejection);
    }

    const securityLayer = securityCheck.layer2Result.then((result) => {
      if (result.rejection !== undefined) {
        routeAbortController.abort();
      }
      return result;
    });

    const [preRouteOutcome, securityOutcome] = await Promise.allSettled([
      runPreRouteCore(securityCheck.sanitizedQuery, plannerAbortSignal),
      securityLayer,
    ]);

    if (securityOutcome.status === 'fulfilled' && securityOutcome.value.rejection !== undefined) {
      throw new PolicyBlockedError(undefined, securityOutcome.value.rejection);
    }
    if (securityOutcome.status === 'rejected') {
      throw securityOutcome.reason;
    }
    if (preRouteOutcome.status === 'fulfilled') {
      return preRouteOutcome.value;
    }
    throw preRouteOutcome.reason;
  } finally {
    ctx.stageTimer?.end('pre_route.security_gate');
  }
}
