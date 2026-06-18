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
import { logSearchEvent } from '../../domain/observability/log-search-event.js';
import { pipelineDebug } from '../../domain/observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../domain/observability/pipeline-debug-steps.js';
import { planToObservabilitySlice } from '../../domain/query/model/query-observability-vocab.js';
import { compileFromLegacyPlan } from './search-usecase-compiled-fallback.js';
import {
  buildCallerControlledPrimitivePlan,
  buildSimilarToEntityPrimitivePlan,
  isCallerControlledPrimitiveSearchRequest,
  isSimilarToEntityPrimitiveSearchRequest,
} from './search-usecase-caller-controlled-plan.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../domain/retrieval/model/retrieval-objective.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { abortError } from '../../domain/shared/cooperative-abort.js';
import { PolicyBlockedError } from '../../domain/shared/error/policy-blocked.js';
import { buildTrivialGraphFromAtoms } from '../../domain/query/service/build-trivial-graph-from-atoms.js';
import { isConstraintGraphEmitEnabled } from '../../domain/query/service/constraint-graph-flags.js';
import { liftBundleToAtoms } from '../../domain/shared/types/constraint-atom.js';
import {
  isAppellationHardFilterAvailable,
  isSensorySoftPromotionAvailable,
  type SearchSnapshotFieldAvailability,
} from '../../domain/shared/types/search-field-availability.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import type { AnchorRefreshCallback } from '../../domain/query/service/anchor-refresh.js';

/** Hard timeout for decomposed (multi-sub-query) search execution. */
const DECOMPOSED_SEARCH_TIMEOUT_MS = 15_000;
const DECOMPOSED_SEARCH_MIN_TIMEOUT_MS = 1;
const STRUCTURED_SET_RETRIEVAL_PREFERENCE_ATTRIBUTES = new Set([
  'alcohol_pct',
  'beginner_suitability',
  'closure',
  'gift_suitability',
  'occasion',
  'price_band',
  'price_usd',
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
const PRE_ROUTE_ABORTED = Symbol('pre_route_aborted');
const SENSORY_SOFT_PROMOTION_ATTRIBUTES = ['body', 'sweetness', 'acidity', 'tannin'] as const;

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

function rebuildCompiledForConstraintMutation(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  const admissionContext = {
    requires_identity_seal: plan.admission_context?.requires_identity_seal ?? false,
    requires_constraint_evidence: plan.constraints.hard.length > 0,
    requires_anchor_evidence: plan.admission_context?.requires_anchor_evidence ?? false,
  } as const;
  const nextPlan: QueryPlanV1 = {
    ...plan,
    admission_context: admissionContext,
  };
  const { constraintGraph: _droppedStaleGraph, ...compiledSansGraph } = compiled;
  const regeneratedGraph = isConstraintGraphEmitEnabled()
    ? buildTrivialGraphFromAtoms(liftBundleToAtoms(plan.constraints))
    : undefined;
  const nextCompiled: CompiledWineQuery = {
    ...compiledSansGraph,
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
    ...(regeneratedGraph !== undefined ? { constraintGraph: regeneratedGraph } : {}),
  };
  return { plan: nextPlan, compiled: nextCompiled };
}

/**
 * C2-Downstream — `appellation` hard-constraint demotion.
 *
 * The old blanket demotion was correct only while the indexed corpus had
 * effectively zero `appellation` coverage. That is no longer a safe code
 * constant: ETL/build now preserve the field and publish a snapshot-level
 * `fieldAvailability.appellation` metric. Demotion is therefore conditional:
 *
 * - availability present + ratio above gate => keep hard filter semantics
 * - availability absent or below gate => demote to soft to avoid zero-hit collapse
 *
 * This preserves fail-closed behaviour for stale / incomplete runtimes while
 * allowing exact appellation retrieval once the substrate is actually ready.
 */
const APPELLATION_DEMOTION_MAPPING_VERSION = 'c2-downstream-appellation-demotion-v1';

function applyAppellationDataAvailabilityDemotion(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  fieldAvailability?: SearchSnapshotFieldAvailability,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  const appellationHard = plan.constraints.hard.filter(
    (constraint) => constraint.attribute === 'appellation',
  );
  if (
    appellationHard.length === 0
    || isAppellationHardFilterAvailable(fieldAvailability)
  ) {
    return { plan, compiled };
  }

  const appellationHardKeys = new Set(appellationHard.map(representativeConstraintKey));
  const hard = plan.constraints.hard.filter(
    (constraint) => !appellationHardKeys.has(representativeConstraintKey(constraint)),
  );

  // Re-tag demoted constraints with a dedicated mapping_version so the
  // soft-promotion path in constraint-to-sparse-filter-tokens.ts does NOT
  // re-promote them to hard YQL filters. Authority is deny-by-default, and
  // this seam never reassigns allow on demoted appellation constraints.
  const demotedSoft = appellationHard.map((constraint) => ({
    ...constraint,
    mapping_version: APPELLATION_DEMOTION_MAPPING_VERSION,
  }));
  const existingSoftKeys = new Set(plan.constraints.soft.map(representativeConstraintKey));
  const newSoft = demotedSoft.filter(
    (constraint) => !existingSoftKeys.has(representativeConstraintKey(constraint)),
  );

  const constraints = {
    ...plan.constraints,
    hard,
    soft: [...plan.constraints.soft, ...newSoft],
  };
  return rebuildCompiledForConstraintMutation({
    ...plan,
    constraints,
  }, compiled);
}

function applySensorySoftPromotionCapabilityPolicy(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  fieldAvailability?: SearchSnapshotFieldAvailability,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  const soft: NormalizedConstraint[] = plan.constraints.soft.map((constraint) => {
    if (!SENSORY_SOFT_PROMOTION_ATTRIBUTES.includes(
      constraint.attribute as (typeof SENSORY_SOFT_PROMOTION_ATTRIBUTES)[number],
    )) {
      return constraint;
    }

    const attribute = constraint.attribute as (typeof SENSORY_SOFT_PROMOTION_ATTRIBUTES)[number];
    if (isSensorySoftPromotionAvailable(fieldAvailability, attribute)) {
      if (constraint.soft_promotion_authority === 'allow') {
        return constraint;
      }
      return {
        ...constraint,
        soft_promotion_authority: 'allow' as const,
      };
    }

    if (constraint.soft_promotion_authority === undefined) {
      return constraint;
    }

    const { soft_promotion_authority: _drop, ...withoutAuthority } = constraint;
    return withoutAuthority;
  });

  const changed = soft.some((constraint, index) => constraint !== plan.constraints.soft[index]);
  if (!changed) {
    return { plan, compiled };
  }

  return rebuildCompiledForConstraintMutation({
    ...plan,
    constraints: {
      ...plan.constraints,
      soft,
    },
  }, compiled);
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
  return rebuildCompiledForConstraintMutation({
    ...plan,
    constraints,
  }, compiled);
}

function requestHasStructuredSetRetrievalPreference(
  request: SearchRequest,
): boolean {
  return (request.preferences ?? []).some((constraint) =>
    STRUCTURED_SET_RETRIEVAL_PREFERENCE_ATTRIBUTES.has(constraint.attribute),
  );
}

function planHasStructuredSetRetrievalPreference(
  plan: QueryPlanV1,
): boolean {
  return [...plan.constraints.soft, ...plan.constraints.inferred].some((constraint) =>
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
      && !planHasStructuredSetRetrievalPreference(plan)
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
  readonly fieldAvailability?: SearchSnapshotFieldAvailability | undefined;
  readonly securityGateDeps: SearchSecurityGateDeps;
  readonly queryPlanner: QueryPlannerPort;
  readonly entityLookupAnchorRefresh?: AnchorRefreshCallback | undefined;
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

function shouldBypassPublicQueryEntrySecurity(
  ctx: SearchPreRoutePhaseContext,
): boolean {
  if (ctx.executionPrincipal === 'benchmark_trusted') {
    return true;
  }

  if (ctx.executionPrincipal !== 'agent_internal_trusted') {
    return false;
  }

  return ctx.request.primitiveRoute === 'similar_to_entity';
}

async function refreshEntityLookupAnchorsIfNeeded(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
  anchorRefresh?: AnchorRefreshCallback,
): Promise<{ readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery }> {
  if (
    anchorRefresh === undefined
    || compiled.execution.effectiveRetrievalMode !== 'entity_lookup'
    || plan.anchors.length > 0
  ) {
    return { plan, compiled };
  }

  const refreshResult = await anchorRefresh({
    normalizedQuery: plan.normalizedQuery,
    existingAnchors: plan.anchors,
  });
  if (refreshResult.status !== 'refreshed') {
    return { plan, compiled };
  }

  const refreshedPlan: QueryPlanV1 = {
    ...plan,
    anchors: refreshResult.anchors,
  };
  const refreshedCompiled = compileFromLegacyPlan(refreshedPlan, {
    apiRouteOverride:
      compiled.execution.routeSource === 'api_override'
        ? refreshedPlan.route
        : undefined,
    maxCandidatesOverride: compiled.execution.budget.maxCandidates,
  });
  return { plan: refreshedPlan, compiled: refreshedCompiled };
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
    const callerControlledPrimitiveSearch =
      isCallerControlledPrimitiveSearchRequest(ctx.request);
    const similarToEntityPrimitiveSearch =
      isSimilarToEntityPrimitiveSearchRequest(ctx.request);
    // Any path-authoritative primitive plan: the planner is bypassed and the
    // caller's structured filters/preferences are ALREADY baked into the plan
    // by the dedicated builder (so the constraint re-merge below must skip them
    // to avoid double-application).
    const pathAuthoritativePrimitiveSearch =
      callerControlledPrimitiveSearch
      || similarToEntityPrimitiveSearch;
    if (ctx.decomposedSearch) {
      if (pathAuthoritativePrimitiveSearch) {
        pipelineDebug(
          {
            step: PipelineDebugStep.PRE_ROUTE_DECOMPOSED_COMPARISON,
            skipped_due_to_caller_authority: true,
          },
          'pipeline pre_route decomposition skipped for caller-controlled primitive search',
        );
      } else {
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
                step: PipelineDebugStep.PRE_ROUTE_DECOMPOSED_COMPARISON,
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
                  step: PipelineDebugStep.PRE_ROUTE_DECOMPOSED_COMPARISON,
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
                  step: PipelineDebugStep.PRE_ROUTE_DECOMPOSED_COMPARISON,
                  decomposition_strategy: decomposition.hint.strategy,
                },
                'pipeline pre_route comparison branch',
              );
              return { outcome: 'return', response };
            }
          }
        }
      }
    }

    let plan: QueryPlanV1;
    let compiled: CompiledWineQuery;
    if (similarToEntityPrimitiveSearch) {
      ({ plan, compiled } = buildSimilarToEntityPrimitivePlan(
        ctx.request,
        sanitizedQuery,
      ));
    } else if (callerControlledPrimitiveSearch) {
      ({ plan, compiled } = buildCallerControlledPrimitivePlan(
        ctx.request,
        sanitizedQuery,
      ));
    } else {
      // Use planWithCompiled when available (PlannerV1Adapter implements this).
      // Falls back to plan() + local ExecutionCompiler for adapters that only implement the base port.
      const plannerContext = buildPlannerContextFromSearchRequest(ctx.request, {
        ...(plannerAbortSignal !== undefined ? { abortSignal: plannerAbortSignal } : {}),
        ...(ctx.debugRequest === true ? { debugRequest: true } : {}),
        ...(ctx.stageTimer !== undefined ? { stageTimer: ctx.stageTimer } : {}),
        requestId: ctx.requestId,
      });
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
    }

    ({ plan, compiled } = await refreshEntityLookupAnchorsIfNeeded(
      plan,
      compiled,
      ctx.entityLookupAnchorRefresh,
    ));

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
    if (
      !pathAuthoritativePrimitiveSearch
      && ctx.request.filters !== undefined
      && ctx.request.filters.length > 0
    ) {
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

    if (
      !pathAuthoritativePrimitiveSearch
      && ctx.request.preferences !== undefined
      && ctx.request.preferences.length > 0
    ) {
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
      ({ plan, compiled } = rebuildCompiledForConstraintMutation(plan, compiled));
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

    // C2-Downstream: snapshot-published field availability is now the
    // authority. Blanket demotion is stale; only demote when the active
    // runtime reports insufficient `appellation` coverage.
    ({ plan, compiled } = applyAppellationDataAvailabilityDemotion(
      plan,
      compiled,
      ctx.fieldAvailability,
    ));

    ({ plan, compiled } = applySensorySoftPromotionCapabilityPolicy(
      plan,
      compiled,
      ctx.fieldAvailability,
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
          step: PipelineDebugStep.PRE_ROUTE_CONSTRAINT_CONTRADICTION,
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
            step: PipelineDebugStep.PRE_ROUTE_CACHE_HIT,
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
        step: PipelineDebugStep.PRE_ROUTE_CONTINUE,
        query_class: plan.queryClass,
        plan_route: plan.route,
        compiled_route: compiled.execution.effectiveRoute,
        compiled_mode: compiled.execution.effectiveRetrievalMode,
      },
      'pipeline pre_route plan ready',
    );

    return { outcome: 'continue', plan, compiled };
  };

  if (shouldBypassPublicQueryEntrySecurity(ctx)) {
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
    const preRouteCore: Promise<SearchPreRoutePhaseResult | typeof PRE_ROUTE_ABORTED> =
      runPreRouteCore(securityCheck.sanitizedQuery, plannerAbortSignal)
      .catch((err: unknown) => {
        // Security fail-closed aborts the planner/speculative pre-route work.
        // Those downstream branches may ignore cancellation and reject later;
        // once aborted, convert any late failure into a sentinel so the request
        // can return POLICY_BLOCKED immediately without leaking an
        // unhandledRejection from the abandoned speculative work.
        if (plannerAbortSignal.aborted) {
          return PRE_ROUTE_ABORTED;
        }
        throw err;
      });

    const securityOutcome = await securityLayer;
    if (securityOutcome.rejection !== undefined) {
      throw new PolicyBlockedError(undefined, securityOutcome.rejection);
    }

    const preRouteOutcome = await preRouteCore;
    if (preRouteOutcome === PRE_ROUTE_ABORTED) {
      throw abortError('Pre-route execution aborted');
    }
    return preRouteOutcome;
  } finally {
    ctx.stageTimer?.end('pre_route.security_gate');
  }
}
