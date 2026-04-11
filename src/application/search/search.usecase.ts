import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { QueryClassWeights } from '../../domain/ranking/index.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { QueryEntrySecurityObserver } from '../../domain/security/port/security-observer.port.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../observability/request-pipeline-debug.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { PIPELINE_DEFECT_CODES } from '../../domain/shared/error/pipeline-defect-codes.js';
import { isAbortError, throwIfAborted } from '../../domain/shared/cooperative-abort.js';
import { dispatchSearchRouteExecution } from './search-usecase-route-dispatch.js';
import type { SearchRouteExecutionResult } from './search-usecase-route-dispatch.js';
import { runSearchPreRoutePhase } from './search-usecase-pre-route-phase.js';
import type {
  SearchExecutionOptions,
  SearchExecutorEvaluationResult,
} from './port/search-executor.port.js';
import type { DecomposedSearchUseCasePort } from './port/search-route-usecases.port.js';
import type { SearchRequest } from './search-request.dto.js';
import type { CacheLookupRuntimeState } from './search-usecase-cache-lookup.js';
import type {
  BlockingUseCasePort,
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
  DecisionEnginePort,
  EntityDocumentLookupPort,
  EntityResolverPort,
  MixedSolverPort,
  QueryPlannerPort,
  RankingPort,
  ResponseBuilderPort,
} from './port/search-pipeline-deps.port.js';
import {
  executeHybridRouteRankingPipeline,
  resolveEntityRouteForPlan,
} from './search-usecase-hybrid-ranking-pipeline.js';
import {
  buildFailedMixedRouteExecution,
  mixedQueryResultToSearchRouteExecution,
} from './search-usecase-mixed-route.js';
import { buildSearchRouteResolutionContext } from './search-usecase-route-resolution.js';
import { runSearchPostRoutePhase } from './search-usecase-post-route-phase.js';
import { buildResolverCandidatesFromGenerator } from './search-usecase-resolver-candidates.js';
import {
  shouldTriggerCorrectiveRetry,
  resolveCorrectiveRetryOutcome,
} from './search-usecase-corrective-retry.js';
import { MixedRouteDegradationError } from '../../domain/mixed/model/mixed-degradation.js';
import {
  rankedResultsToEvalProvenanceSlices,
  searchResponseToEvalProvenanceSlices,
} from './search-usecase-eval-provenance.js';

export type { SearchRequest } from './search-request.dto.js';

/**
 * Version info injected into the SearchUseCase for snapshot population.
 * Per RFC-015, snapshots must carry actual version strings.
 */
export interface SnapshotVersions {
  /** ML model version identifiers, e.g. { embedding: "bge-m3-v1.2" }. */
  readonly modelVersions: Readonly<Record<string, string>>;
  /** Search index version identifiers, e.g. { wine_content: "2026-04-01" }. */
  readonly indexVersions: Readonly<Record<string, string>>;
  /** Feature flags / kill switches active at runtime. */
  readonly featureFlags: Readonly<Record<string, boolean>>;
}

/**
 * Dependencies injected into the SearchUseCase.
 */
export interface SearchUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  readonly entityResolver: EntityResolverPort;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
  /**
   * TA2-4: Application-layer blocker for seeding candidates not covered by
   * anchor alias lookup. Optional — when absent, the entity route falls back
   * to anchors-only behaviour (pre-TA2 behaviour preserved).
   */
  readonly blocker?: BlockingUseCasePort | undefined;
  readonly candidatePool: CandidatePoolPort;
  readonly browseRetriever?: BrowseRetrieverPort | undefined;
  readonly compareRetriever?: CompareRetrieverPort | undefined;
  readonly ranker: RankingPort;
  readonly decisionEngine: DecisionEnginePort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly mixedSolver: MixedSolverPort;
  /** Drinking window predictor for wine aging insights (Epic 15). */
  readonly drinkingWindow?: DrinkingWindowUseCasePort | undefined;
  /** Version strings for RFC-015 snapshot population. */
  readonly snapshotVersions?: SnapshotVersions | undefined;
  /** Layer 1: Static pattern-based injection sanitizer (Epic 16.1). Required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). Optional. */
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly queryEntrySecurityObserver?: QueryEntrySecurityObserver | undefined;
  /** Unified cache service for query/embedding/result caching (Wave 4, Phase 3). Optional. */
  readonly cacheService?: SearchResponseCachePort | undefined;
  readonly cacheLookupRuntimeState?: CacheLookupRuntimeState | undefined;
  readonly cacheLookupRuntimeStateProvider?: (() => CacheLookupRuntimeState) | undefined;
  /** Epic 4: Per-query-class LambdaMART models for LTR reranking. Optional. */
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
  /** Epic 14: Decomposed search for "A vs B" comparison queries. Optional. */
  readonly decomposedSearch?: DecomposedSearchUseCasePort | undefined;
}

/**
 * Main search use case orchestrator.
 *
 * Pipeline:
 * 1. Parse & validate request
 * 2. Plan query (QueryPlanner)
 * 3. Route based on mode (auto/entity/hybrid/mixed)
 * 4. Build DecisionInput from resolver/ranking results
 * 5. Run DecisionEngine
 * 6. Build SearchResponseV1 via ResponseBuilder
 * 7. Track request_id, latency, route throughout
 */
// PIPELINE_DEFECT_CODES imported from domain SSoT (Rule 30) — shared with
// SearchPipelineEvaluator which cannot import from this application layer.
// Do NOT redefine locally; changes here would drift from pipeline-defect-codes.ts.

export class SearchUseCase {
  private readonly abstainPolicy = new AbstainPolicy();
  private readonly constraintSAT = new ConstraintSAT();

  constructor(private readonly deps: SearchUseCaseDeps) {}

  async execute(
    request: SearchRequest,
    requestId: string,
    options?: SearchExecutionOptions,
  ): Promise<SearchResponseV1 | ComparisonSearchResponse> {
    const execution = await this.executeInternal(request, requestId, false, options);
    return execution.response;
  }

  async executeForEvaluation(
    request: SearchRequest,
    requestId: string,
    options?: SearchExecutionOptions,
  ): Promise<SearchExecutorEvaluationResult> {
    return this.executeInternal(request, requestId, true, options);
  }

  private async executeInternal(
    request: SearchRequest,
    requestId: string,
    includeEvalProvenance: boolean,
    options?: SearchExecutionOptions,
  ): Promise<SearchExecutorEvaluationResult> {
    const startTime = Date.now();
    try {
      return await this.executeInternalUnsafe(
        request,
        requestId,
        includeEvalProvenance,
        startTime,
        options,
      );
    } catch (err) {
      if (err instanceof DomainError) {
        // Evidence-obligation and wrong-resolve errors indicate upstream defects —
        // log at error level before propagating so request_id is captured in the trace.
        // Policy-blocked and snapshot errors are deliberate pipeline signals and need no log here.
        if (PIPELINE_DEFECT_CODES.has(err.code)) {
          bootstrapLogger.error(
            { requestId, code: err.code, err: err.message },
            '[SearchUseCase] Pipeline defect DomainError — propagating to HTTP error handler',
          );
        }
        throw err;
      }
      if (isAbortError(err)) {
        throw err;
      }

      // Unexpected errors (OOM, Redis down, nil deref, etc.) must surface as
      // HTTP 500 — NOT as a fabricated 200 with decisionStatus:'failed'.
      // The prior code here built a "degraded" SearchResponseV1 and returned
      // it, which the route emitted as 200 to the client. This hid genuine
      // infrastructure failures behind a success status code, blinding
      // monitoring, SLOs, and client retry logic.
      //
      // Wrap as DomainError so the global HTTP error handler maps it to 500
      // with the RFC-014 error contract shape. The original error is
      // preserved as `cause` for structured logging.
      const errorMessage = err instanceof Error ? err.message : String(err);
      bootstrapLogger.error(
        { err: errorMessage, requestId },
        '[SearchUseCase] Unexpected error in execute pipeline — propagating as 500',
      );
      throw new DomainError(
        'INTERNAL_INCONSISTENCY',
        `Search pipeline failed unexpectedly: ${errorMessage}`,
      );
    }
  }

  private async executeInternalUnsafe(
    request: SearchRequest,
    requestId: string,
    includeEvalProvenance: boolean,
    startTime: number,
    options?: SearchExecutionOptions,
  ): Promise<SearchExecutorEvaluationResult> {
    throwIfAborted(options?.abortSignal, 'Search execution aborted');

    pipelineDebug(
      {
        step: 'search.execute.start',
        eval_mode: includeEvalProvenance,
        query_len: request.query.length,
        query_preview: sanitizeQueryForDebug(request.query),
      },
      'pipeline search.execute',
    );

    const preRoute = await runSearchPreRoutePhase({
      request,
      ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      requestId,
      startTime,
      snapshotVersions: this.deps.snapshotVersions,
      securityGateDeps: {
        querySanitizer: this.deps.querySanitizer,
        injectionJudge: this.deps.injectionJudge,
        judgeFailureMode: this.deps.judgeFailureMode,
        queryEntrySecurityObserver: this.deps.queryEntrySecurityObserver,
      },
      queryPlanner: this.deps.queryPlanner,
      responseBuilder: this.deps.responseBuilder,
      constraintSAT: this.constraintSAT,
      cacheService: this.deps.cacheService,
      cacheLookupRuntimeState:
        this.deps.cacheLookupRuntimeStateProvider?.()
        ?? this.deps.cacheLookupRuntimeState,
      decomposedSearch: this.deps.decomposedSearch,
    });

    throwIfAborted(options?.abortSignal, 'Search execution aborted');

    if (preRoute.outcome === 'return') {
      pipelineDebug(
        {
          step: 'search.pre_route.early_exit',
          query_type: preRoute.response.queryType,
        },
        'pipeline pre_route return',
      );
      // Note on options.explain: pre-route early exits (security blocks,
      // clarification asks) have no ranked candidates, so there is nothing to
      // produce counterfactuals from. explain=true is intentionally a no-op
      // here — the response carries clarification or block reasons instead,
      // which is the correct affordance for this branch.
      const response = preRoute.response;
      if (includeEvalProvenance && response.queryType === 'search') {
        const retrievalProvenanceSlices = searchResponseToEvalProvenanceSlices(response);
        return {
          response,
          ...(retrievalProvenanceSlices.length > 0 ? { retrievalProvenanceSlices } : {}),
        };
      }
      return { response };
    }

    const { plan, compiled } = preRoute;

    // Step 2: Determine effective route.
    // compiled.execution is the authoritative source (ExecutionCompiler-resolved).
    // buildSearchRouteResolutionContext provides the plannerSuggestedMode and source metadata.
    const {
      effectiveRoute,
      plannerSuggestedMode,
      retrievalModeSource,
    } = buildSearchRouteResolutionContext(plan, request, compiled);

    pipelineDebug(
      {
        step: 'search.route_resolution',
        query_class: plan.queryClass,
        effective_route: effectiveRoute,
        compiled_retrieval_mode: compiled.execution.effectiveRetrievalMode,
        planner_suggested_mode: plannerSuggestedMode,
        retrieval_mode_source: retrievalModeSource,
      },
      'pipeline route context',
    );

    // Step 3: Execute based on route
    const {
      resolveResult,
      rankedResults,
      decisionContext,
      routeDegradation,
      funnelMetrics,
      rankingMetadata,
      specializedRouteObservability,
      retrievalFusionTrace,
    } = await dispatchSearchRouteExecution(
      effectiveRoute,
      {
        executeEntity: () => this.executeEntityRoute(plan),
        executeHybrid: () => this.executeHybridRoute(plan, compiled),
        executeMixed: async () => {
          try {
            const mixedResult = await this.deps.mixedSolver.solve(plan, compiled);
            return mixedQueryResultToSearchRouteExecution(plan, mixedResult);
          } catch (error) {
            if (error instanceof MixedRouteDegradationError) {
              return buildFailedMixedRouteExecution(plan, error.reason);
            }
            throw error;
          }
        },
      },
    );

    throwIfAborted(options?.abortSignal, 'Search execution aborted');

    // Steps 3b–7: Entropy abstain (RFC-013) → DecisionEngine → response → cache write
    const response = await runSearchPostRoutePhase({
      plan,
      compiled,
      request,
      requestId,
      startTime,
      resolveResult,
      rankedResults,
      decisionContext,
      effectiveRoute,
      plannerSuggestedMode,
      retrievalModeSource,
      abstainPolicy: this.abstainPolicy,
      snapshotVersions: this.deps.snapshotVersions,
      drinkingWindow: this.deps.drinkingWindow,
      decisionEngine: this.deps.decisionEngine,
      responseBuilder: this.deps.responseBuilder,
      cacheService: this.deps.cacheService,
      routeDegradation,
      ...(rankingMetadata !== undefined ? { rankingMetadata } : {}),
      specializedRouteObservability,
      ...(retrievalFusionTrace !== undefined ? { retrievalFusionTrace } : {}),
      // Wire HTTP options.explain → includeCounterfactuals symmetrically:
      //   explain=true  → includeCounterfactuals=true (force on)
      //   explain=false → includeCounterfactuals=false (force off)
      //   explain undefined → leave undefined (obligation map decides)
      ...(request.options?.explain !== undefined
        ? { includeCounterfactuals: request.options.explain }
        : {}),
    });

    pipelineDebug(
      {
        step: 'search.execute.done',
        latency_ms: Date.now() - startTime,
        ranked_count: rankedResults.length,
        resolve_status: resolveResult.status,
      },
      'pipeline search.execute complete',
    );

    const retrievalProvenanceSlices = includeEvalProvenance
      ? rankedResultsToEvalProvenanceSlices(requestId, rankedResults)
      : [];
    const evaluationFunnelMetrics = includeEvalProvenance ? funnelMetrics : undefined;

    return {
      response,
      ...(retrievalProvenanceSlices.length > 0 ? { retrievalProvenanceSlices } : {}),
      ...(evaluationFunnelMetrics !== undefined ? { funnelMetrics: evaluationFunnelMetrics } : {}),
    };
  }

  /**
   * Entity-only route: run EntityResolver with TA3 corrective retry loop.
   *
   * Implements a maximum-1 corrective exact-recovery retry (TA3-1/TA3-2):
   *
   *   Pass 1: Build candidates from plan anchors, resolve.
   *   If shouldTriggerCorrectiveRetry() → Pass 2: broader blocker recall +
   *     re-hydrate candidates → re-resolve with expanded candidate set.
   *   After Pass 2: apply resolveCorrectiveRetryOutcome() exit conditions.
   *
   * The retry is NOT a broad search fallback — it is an exact-recovery retry.
   * Ambiguous misses and 'clarify'/'fail' recommendations skip the retry.
   */
  // NOTE: compiled (CompiledWineQuery) is intentionally not passed to the entity route.
  // Entity resolution uses QueryPlanV1 policy fields directly (requireExact, allowApproximate).
  // compiled.execution.budget and provenancePolicy are NOT applied to entity queries.
  // To extend compiled-first semantics to entity route, thread compiled through EntityResolver.
  private async executeEntityRoute(plan: QueryPlanV1): Promise<EntityResolveResult> {
    // TA2-4: Run blocker to surface entity IDs not covered by alias anchors.
    // blockerOnlyIds = blocker output minus IDs already in anchor candidateEntityIds.
    const blockerOnlyIds = await this.runBlockerForPlan(plan, false);

    const candidateEntities = await buildResolverCandidatesFromGenerator(
      {
        rawQuery: plan.rawQuery,
        normalizedQuery: plan.normalizedQuery,
        anchors: plan.anchors,
        ...(blockerOnlyIds.length > 0 ? { blockerOnlyIds } : {}),
      },
      this.deps.entityLookup,
    );

    pipelineDebug(
      {
        step: 'route.entity.only.start',
        query_class: plan.queryClass,
        resolver_candidate_count: candidateEntities.length,
        blocker_seed_count: blockerOnlyIds.length,
      },
      'pipeline entity-only route',
    );

    // Pass 1 resolve
    const firstResult = await this.deps.entityResolver.resolve({
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      ...(plan.normalizedQueryViews !== undefined
        ? { normalizedQueryViews: plan.normalizedQueryViews }
        : {}),
      queryClass: plan.queryClass,
      policy: plan.policy,
      anchorCandidates: plan.anchors,
      uncertainty: plan.uncertainty,
      candidateEntities,
    });

    // TA3-1: Evaluate corrective retry trigger conditions
    const triggerRetry = shouldTriggerCorrectiveRetry(plan, firstResult);

    if (!triggerRetry) {
      pipelineDebug(
        {
          step: 'route.entity.only.done',
          resolve_status: firstResult.status,
          candidate_count: firstResult.candidates.length,
          corrective_retry: false,
          has_degradation: firstResult.degradation !== undefined,
        },
        'pipeline entity-only route',
      );
      return firstResult;
    }

    // TA3-2: Corrective retry — broader blocker recall + candidate re-hydration.
    //
    // Pass 2 uses broader=true to relax the blocker's limit/threshold and surface
    // additional high-recall candidates that Pass 1 missed. New IDs are merged with
    // the Pass 1 candidate set so the resolver sees a strictly larger pool.
    pipelineDebug(
      {
        step: 'route.entity.corrective_retry.start',
        query_class: plan.queryClass,
        first_pass_confidence: firstResult.decisionConfidenceC,
        first_pass_status: firstResult.status,
        anchor_count: plan.anchors.length,
        pass1_blocker_seed_count: blockerOnlyIds.length,
      },
      'pipeline entity corrective retry',
    );

    const broaderBlockerIds = await this.runBlockerForPlan(plan, true);
    // Merge broader IDs with Pass 1 anchor coverage so dedup works correctly.
    const anchorCoveredIds = new Set(
      plan.anchors.flatMap((a) => a.candidateEntityIds.map(String)),
    );
    const pass1BlockerSet = new Set(blockerOnlyIds.map(String));
    const additionalIds = broaderBlockerIds.filter(
      (id) => !anchorCoveredIds.has(String(id)) && !pass1BlockerSet.has(String(id)),
    );

    // Rebuild candidates only when broader recall surfaced new IDs.
    const retryCandidateEntities =
      additionalIds.length > 0
        ? await buildResolverCandidatesFromGenerator(
            {
              rawQuery: plan.rawQuery,
              normalizedQuery: plan.normalizedQuery,
              anchors: plan.anchors,
              blockerOnlyIds: [...blockerOnlyIds, ...additionalIds],
            },
            this.deps.entityLookup,
          )
        : candidateEntities;

    pipelineDebug(
      {
        step: 'route.entity.corrective_retry.candidates',
        pass2_blocker_seed_count: broaderBlockerIds.length,
        additional_ids_count: additionalIds.length,
        retry_candidate_count: retryCandidateEntities.length,
      },
      'pipeline entity corrective retry candidates',
    );

    const retryResult = await this.deps.entityResolver.resolve({
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      ...(plan.normalizedQueryViews !== undefined
        ? { normalizedQueryViews: plan.normalizedQueryViews }
        : {}),
      queryClass: plan.queryClass,
      policy: plan.policy,
      anchorCandidates: plan.anchors,
      uncertainty: plan.uncertainty,
      candidateEntities: retryCandidateEntities,
    });

    // TA3-2: Apply exit conditions after corrective retry
    const outcome = resolveCorrectiveRetryOutcome(retryResult);

    // Use retry result regardless of outcome — the outcome tag is for future
    // clarify/fail routing in the decision layer (post-route phase).
    const resolved = retryResult;

    pipelineDebug(
      {
        step: 'route.entity.only.done',
        resolve_status: resolved.status,
        candidate_count: resolved.candidates.length,
        corrective_retry: true,
        corrective_retry_outcome: outcome,
        has_degradation: resolved.degradation !== undefined,
      },
      'pipeline entity-only route',
    );

    return resolved;
  }

  /**
   * TA2-4 / TA3: Run the blocker to produce entity IDs not covered by anchors.
   *
   * Returns the diff: blocker output IDs that are NOT already in any anchor's
   * `candidateEntityIds`. These are the true "blocker-only" seeds.
   *
   * @param broader  When true, use a higher-recall invocation for corrective retry (TA3).
   */
  private async runBlockerForPlan(
    plan: QueryPlanV1,
    broader: boolean,
  ): Promise<readonly EntityId[]> {
    if (this.deps.blocker === undefined) {
      return [];
    }
    const allBlockerIds = await this.deps.blocker.block(
      plan.rawQuery,
      plan.normalizedQuery,
      broader ? { broader: true } : undefined,
    );
    // Diff: remove IDs already covered by anchor candidateEntityIds
    const anchorCoveredIds = new Set(
      plan.anchors.flatMap((a) => a.candidateEntityIds.map(String)),
    );
    return allBlockerIds.filter((id) => !anchorCoveredIds.has(String(id)));
  }

  /**
   * Hybrid route: delegates to the shared pipeline used by HybridUseCase.
   *
   * The resolveEntity callback uses resolveEntityRouteForPlan (single-pass, no
   * TA3 retry loop) — anchor resolution in the hybrid route only needs to find
   * the pivot entity for compare_candidates, not perform full exact recovery.
   * TA3 corrective retry is intentionally limited to the entity-only route.
   */
  private async executeHybridRoute(
    plan: QueryPlanV1,
    compiled?: CompiledWineQuery,
  ): Promise<SearchRouteExecutionResult> {
    const entityResolutionDeps = {
      entityResolver: this.deps.entityResolver,
      entityLookup: this.deps.entityLookup,
      blocker: this.deps.blocker,
    };
    return executeHybridRouteRankingPipeline(
      plan,
      {
        candidatePool: this.deps.candidatePool,
        browseRetriever: this.deps.browseRetriever,
        compareRetriever: this.deps.compareRetriever,
        ranker: this.deps.ranker,
      },
      (p) => resolveEntityRouteForPlan(p, entityResolutionDeps),
      compiled,
    );
  }
}
