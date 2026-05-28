import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { MultiQueryGenerator } from '../../domain/retrieval/service/multi-query-generator.js';
import type { HydeGenerator } from '../../domain/retrieval/service/hyde-generator.js';
import { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { QueryClassWeights } from '../../domain/ranking/index.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { QueryEntrySecurityObserver } from '../../domain/security/port/security-observer.port.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../domain/observability/request-pipeline-debug.js';
import { PipelineDebugStep } from '../../domain/observability/pipeline-debug-steps.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { PIPELINE_DEFECT_CODES } from '../../domain/shared/error/pipeline-defect-codes.js';
import { isAbortError, throwIfAborted } from '../../domain/shared/cooperative-abort.js';
import {
  buildSearchExecutionLaneTrace,
  dispatchSearchRouteExecution,
  type SearchRouteExecutionResult,
  type EntityRouteResult,
} from './search-usecase-route-dispatch.js';
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
  buildMixedRouteResolveResult,
  buildFailedMixedRouteExecution,
  mixedQueryResultToSearchRouteExecution,
} from './search-usecase-mixed-route.js';
import { buildSearchRouteResolutionContext } from './search-usecase-route-resolution.js';
import { resolveExecutionTopologyFromRequestSurface } from './search-usecase-route-resolution.js';
import { runSearchPostRoutePhase } from './search-usecase-post-route-phase.js';
import { buildResolverCandidatesFromGenerator } from './search-usecase-resolver-candidates.js';
import { shouldSuppressBlockerSeedExpansion } from './search-usecase-blocker-seed-policy.js';
import {
  executeHybridRouteRankingPipeline,
  resolveEntityRouteForPlan,
} from './search-usecase-hybrid-ranking-pipeline.js';
import {
  shouldTriggerCorrectiveRetry,
  resolveCorrectiveRetryOutcome,
  alignRetryResultStatusToOutcome,
  computeCorrectiveRetryCalibration,
} from './search-usecase-corrective-retry.js';
import {
  buildEntityRouteRankedResults,
  liftEntityResolveResultToLaneArtifacts,
} from './search-usecase-entity-ranked-results.js';
import { MixedRouteDegradationError } from '../../domain/mixed/model/mixed-degradation.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import {
  rankedResultsToEvalProvenanceSlices,
  searchResponseToEvalProvenanceSlices,
} from './search-usecase-eval-provenance.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../domain/retrieval/model/retrieval-objective.js';
import { buildNormalizedQueryViews } from '../../domain/query/service/query-normalizer.js';
import { executeDualLaneHybridRoute } from './search-usecase-dual-lane-execution.js';
import type { SearchSnapshotFieldAvailability } from '../../domain/shared/types/search-field-availability.js';

export type { SearchRequest } from './search-request.dto.js';

const MIXED_EMPTY_RESULTS_FALLBACK_REASON = 'mixed_constraint_guided_hybrid_fallback';

/**
 * Version info injected into the SearchUseCase for snapshot population.
 * Per RFC-015, snapshots must carry actual version strings.
 */
export interface SnapshotVersions {
  /** ML model version identifiers, e.g. { embedding: "text-embedding-3-small-v1" }. */
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
  /**
   * Explicit test / special-seam escape hatch for planners that only implement
   * plan(). Production wiring must leave this unset.
   */
  readonly allowCompiledFallback?: boolean | undefined;
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
  readonly fieldAvailability?: SearchSnapshotFieldAvailability | undefined;
  /** Version strings for RFC-015 snapshot population. */
  readonly snapshotVersions?: SnapshotVersions | undefined;
  /** Layer 1: Static pattern-based injection sanitizer (Epic 16.1). Required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). Optional. */
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly judgeTimeoutMs?: number | undefined;
  readonly queryEntrySecurityObserver?: QueryEntrySecurityObserver | undefined;
  /** Unified cache service for query/embedding/result caching (Wave 4, Phase 3). Optional. */
  readonly cacheService?: SearchResponseCachePort | undefined;
  readonly cacheLookupRuntimeState?: CacheLookupRuntimeState | undefined;
  readonly cacheLookupRuntimeStateProvider?: (() => CacheLookupRuntimeState) | undefined;
  /** Epic 4: Per-query-class LambdaMART models for LTR reranking. Optional. */
  readonly ltrModels?: ReadonlyMap<string, QueryClassWeights> | undefined;
  /** Epic 14: Decomposed search for "A vs B" comparison queries. Optional. */
  readonly decomposedSearch?: DecomposedSearchUseCasePort | undefined;
  /**
   * Multi-Query Rewrite generator — pre-retrieval LLM fan-out of the
   * semantic query into N variants. Optional; gated by the
   * `WINE_SEARCH_MULTI_QUERY_ENABLED` env flag (Wave 2: default ON;
   * set `=false` to disable). When present and enabled, threaded
   * through the hybrid retrieval pipeline.
   */
  readonly multiQueryGenerator?: MultiQueryGenerator | undefined;
  /**
   * HyDE generator — produces a hypothetical wine description used as an
   * additional semantic embedding query. Same gating as
   * {@link multiQueryGenerator}.
   */
  readonly hydeGenerator?: HydeGenerator | undefined;
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
    const stageTimer = options?.stageTimer;
    stageTimer?.start('search.total');
    throwIfAborted(options?.abortSignal, 'Search execution aborted');

    pipelineDebug(
      {
        step: PipelineDebugStep.SEARCH_EXECUTE_START,
        eval_mode: includeEvalProvenance,
        query_len: request.query.length,
        query_preview: sanitizeQueryForDebug(request.query),
      },
      'pipeline search.execute',
    );

    stageTimer?.start('search.pre_route');
    const preRoute = await runSearchPreRoutePhase({
      request,
      ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      ...(options?.debugRequest === true ? { debugRequest: true } : {}),
      ...(options?.executionPrincipal !== undefined
        ? { executionPrincipal: options.executionPrincipal }
        : {}),
      ...(stageTimer !== undefined ? { stageTimer } : {}),
      requestId,
      startTime,
      snapshotVersions: this.deps.snapshotVersions,
      fieldAvailability: this.deps.fieldAvailability,
      securityGateDeps: {
        querySanitizer: this.deps.querySanitizer,
        injectionJudge: this.deps.injectionJudge,
        judgeFailureMode: this.deps.judgeFailureMode,
        judgeTimeoutMs: this.deps.judgeTimeoutMs,
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
      allowCompiledFallback: this.deps.allowCompiledFallback,
    }).finally(() => {
      stageTimer?.end('search.pre_route');
    });

    throwIfAborted(options?.abortSignal, 'Search execution aborted');

    if (preRoute.outcome === 'return') {
      stageTimer?.end('search.total');
      pipelineDebug(
        {
          step: PipelineDebugStep.SEARCH_PRE_ROUTE_EARLY_EXIT,
          query_type: preRoute.response.queryType,
        },
        'pipeline pre_route return',
      );
      emitSearchStageTimingSnapshot(stageTimer);
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
    const surfaceExecutionTopology = resolveExecutionTopologyFromRequestSurface(compiled, request);
    const routeSource =
      retrievalModeSource === 'api_override'
        ? 'api_override'
        : compiled.execution.routeSource;
    const surfaceCompiled =
      compiled.execution.effectiveRoute === effectiveRoute
      && compiled.execution.executionTopology === surfaceExecutionTopology
      && compiled.execution.routeSource === routeSource
        ? compiled
        : {
            ...compiled,
            execution: {
              ...compiled.execution,
              effectiveRoute,
              executionTopology: surfaceExecutionTopology,
              routeSource,
            },
          };
    const routeRequestContext: RequestExecutionContext = {
      ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      ...(options?.debugRequest === true ? { debugRequest: true } : {}),
      ...(options?.executionPrincipal !== undefined
        ? { executionPrincipal: options.executionPrincipal }
        : {}),
      ...(stageTimer !== undefined ? { stageTimer } : {}),
      requestId,
      requestStartTimeMs: startTime,
    };

    pipelineDebug(
      {
        step: PipelineDebugStep.SEARCH_ROUTE_RESOLUTION,
        query_class: plan.queryClass,
        effective_route: effectiveRoute,
        execution_topology: surfaceCompiled.execution.executionTopology,
        compiled_retrieval_mode: compiled.execution.effectiveRetrievalMode,
        planner_suggested_mode: plannerSuggestedMode,
        retrieval_mode_source: retrievalModeSource,
      },
      'pipeline route context',
    );

    // Step 3: Execute based on route
    stageTimer?.start('search.route_execution');
    const {
      executedPlan,
      executedCompiled,
      executionTopology,
      identityResolveResult,
      fusedResolveResult: resolveResult,
      laneTrace,
      laneArtifacts,
      rankedResults,
      decisionContext,
      routeDegradation,
      funnelMetrics,
      rankingMetadata,
      effectiveRetrievalMode,
      retrievalKind,
      sparseExecuted,
      specializedRouteExecuted,
      usedCompiledExecution,
      specializedRouteObservability,
      retrievalFusionTrace,
      hardFilterDropLog,
      correctiveRetryCalibration,
      criticRewrites,
      criticRetriesExhausted,
    } = await dispatchSearchRouteExecution(
      effectiveRoute,
      {
        executeEntity: () => this.executeEntityRoute(plan, surfaceCompiled),
        executeHybrid: () => this.executeHybridRoute(
          plan,
          surfaceCompiled,
          routeRequestContext,
        ),
        executeMixed: async () => {
          try {
            const mixedResult = await this.deps.mixedSolver.solve(plan, surfaceCompiled);
            if (mixedResult.rankedResults.length === 0 && plan.constraints.hard.length > 0) {
              const fallbackExecution = buildMixedConstraintFallbackExecution(plan, surfaceCompiled);
              const hybridFallback = await this.executeHybridRoute(
                fallbackExecution.plan,
                fallbackExecution.compiled,
                routeRequestContext,
              );
              return buildMixedHybridFallbackExecution(
                fallbackExecution.plan,
                mixedResult,
                hybridFallback,
              );
            }
            return mixedQueryResultToSearchRouteExecution(plan, mixedResult, compiled);
          } catch (error) {
            if (error instanceof MixedRouteDegradationError) {
              return buildFailedMixedRouteExecution(plan, error.reason, compiled);
            }
            throw error;
          }
        },
      },
    ).finally(() => {
      stageTimer?.end('search.route_execution');
    });

    throwIfAborted(options?.abortSignal, 'Search execution aborted');

    // Steps 3b–7: Entropy abstain (RFC-013) → DecisionEngine → response → cache write
    stageTimer?.start('search.post_route');
    const postRouteEffectiveRoute = executedCompiled.execution.effectiveRoute;
    const postRoutePlannerSuggestedMode = executedCompiled.execution.effectiveRetrievalMode;
    const response = await runSearchPostRoutePhase({
      plan: executedPlan,
      compiled: executedCompiled,
      request,
      requestId,
      startTime,
      resolveResult,
      identityResolveResult,
      rankedResults,
      decisionContext,
      effectiveRoute: postRouteEffectiveRoute,
      plannerSuggestedMode: postRoutePlannerSuggestedMode,
      retrievalModeSource,
      abstainPolicy: this.abstainPolicy,
      snapshotVersions: this.deps.snapshotVersions,
      drinkingWindow: this.deps.drinkingWindow,
      decisionEngine: this.deps.decisionEngine,
      responseBuilder: this.deps.responseBuilder,
      cacheService: this.deps.cacheService,
      routeDegradation,
      ...(rankingMetadata !== undefined ? { rankingMetadata } : {}),
      executionTopology,
      laneTrace,
      laneArtifacts,
      effectiveRetrievalMode,
      retrievalKind,
      sparseExecuted,
      specializedRouteExecuted,
      usedCompiledExecution,
      specializedRouteObservability,
      ...(retrievalFusionTrace !== undefined ? { retrievalFusionTrace } : {}),
      ...(hardFilterDropLog !== undefined && hardFilterDropLog.length > 0
        ? { hardFilterDropLog }
        : {}),
      ...(correctiveRetryCalibration !== undefined ? { correctiveRetryCalibration } : {}),
      ...(criticRewrites !== undefined && criticRewrites.length > 0
        ? { criticRewrites }
        : {}),
      ...(criticRetriesExhausted === true ? { criticRetriesExhausted: true } : {}),
      // Stage timing snapshot for the response (latency breakdown probe).
      ...(stageTimer !== undefined ? { stageTimings: stageTimer.snapshot() } : {}),
      // Wire HTTP options.explain → includeCounterfactuals symmetrically:
      //   explain=true  → includeCounterfactuals=true (force on)
      //   explain=false → includeCounterfactuals=false (force off)
      //   explain undefined → leave undefined (obligation map decides)
      ...(request.options?.explain !== undefined
        ? { includeCounterfactuals: request.options.explain }
        : {}),
    }).finally(() => {
      stageTimer?.end('search.post_route');
    });

    stageTimer?.end('search.total');

    pipelineDebug(
      {
        step: PipelineDebugStep.SEARCH_EXECUTE_DONE,
        latency_ms: Date.now() - startTime,
        ranked_count: rankedResults.length,
        resolve_status: resolveResult.status,
      },
      'pipeline search.execute complete',
    );
    emitSearchStageTimingSnapshot(stageTimer);

    const retrievalProvenanceSlices = includeEvalProvenance
      ? rankedResultsToEvalProvenanceSlices(requestId, rankedResults)
      : [];
    const evaluationFunnelMetrics = includeEvalProvenance ? funnelMetrics : undefined;

    return {
      response,
      ...(retrievalProvenanceSlices.length > 0 ? { retrievalProvenanceSlices } : {}),
      ...(evaluationFunnelMetrics !== undefined ? { funnelMetrics: evaluationFunnelMetrics } : {}),
      runtimeClassification: {
        queryClass: executedPlan.queryClass,
        intent: executedPlan.intent,
        route: postRouteEffectiveRoute,
        retrievalMode: postRoutePlannerSuggestedMode,
      },
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
  private async executeEntityRoute(
    plan: QueryPlanV1,
    compiled: CompiledWineQuery,
  ): Promise<EntityRouteResult> {
    // TA2-4: Run blocker to surface entity IDs not covered by alias anchors.
    // blockerOnlyIds = blocker output minus IDs already in anchor candidateEntityIds.
    const blockerOnlyIds = this.capBlockerSeedIds(
      plan,
      await this.runBlockerForPlan(plan, false),
      compiled,
    );

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
        step: PipelineDebugStep.ROUTE_ENTITY_ONLY_START,
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
      const rankedResults = buildEntityRouteRankedResults(plan, firstResult, candidateEntities);
      const laneArtifacts = {
        identity: liftEntityResolveResultToLaneArtifacts(plan, firstResult, candidateEntities),
        general: [],
        fused: [],
      };
      const topRankedResult = rankedResults[0];
      pipelineDebug(
        {
          step: PipelineDebugStep.ROUTE_ENTITY_ONLY_DONE,
          resolve_status: firstResult.status,
          candidate_count: firstResult.candidates.length,
          ranked_count: rankedResults.length,
          corrective_retry: false,
          ...(firstResult.decisionTrace.outcomeReasonCodes.length > 0
            ? { outcome_reason_codes: firstResult.decisionTrace.outcomeReasonCodes }
            : {}),
          ...(topRankedResult !== undefined
            ? {
                top_hard_constraint_pass: topRankedResult.componentScores.hardConstraintPass,
                top_matched_constraints: topRankedResult.matchedConstraints,
                top_unmet_constraints: topRankedResult.unmetConstraints,
                top_evidence_item_count: topRankedResult.evidenceItems.length,
              }
            : {}),
          has_degradation: firstResult.degradation !== undefined,
        },
        'pipeline entity-only route',
      );
      return {
        executionTopology: 'entity_only',
        executedPlan: plan,
        executedCompiled: compiled,
        identityResolveResult: firstResult,
        fusedResolveResult: firstResult,
        laneArtifacts,
        laneTrace: buildSearchExecutionLaneTrace({
          executionTopology: 'entity_only',
          identityResolveResult: firstResult,
          fusedResolveResult: firstResult,
          laneArtifacts,
        }),
        rankedResults,
        effectiveRetrievalMode: compiled.execution.effectiveRetrievalMode,
        usedCompiledExecution: true,
        retrievalKind: 'entity_lookup',
        sparseExecuted: false,
        specializedRouteExecuted: null,
      };
    }

    // TA3-2: Corrective retry — broader blocker recall + candidate re-hydration.
    //
    // Pass 2 uses broader=true to relax the blocker's limit/threshold and surface
    // additional high-recall candidates that Pass 1 missed. New IDs are merged with
    // the Pass 1 candidate set so the resolver sees a strictly larger pool.
    pipelineDebug(
      {
        step: PipelineDebugStep.ROUTE_ENTITY_CORRECTIVE_RETRY_START,
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
    const additionalIds = this.capCorrectiveRetryAdditionalIds(
      plan,
      broaderBlockerIds.filter(
        (id) => !anchorCoveredIds.has(String(id)) && !pass1BlockerSet.has(String(id)),
      ),
      blockerOnlyIds,
      compiled,
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
        step: PipelineDebugStep.ROUTE_ENTITY_CORRECTIVE_RETRY_CANDIDATES,
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

    // TA5: Compute calibrated posterior confidence for the retry outcome.
    // Only populated for 'accept' outcomes; undefined for clarify/fail.
    const retryCalibratedConfidence = computeCorrectiveRetryCalibration(retryResult, outcome);

    // TA3-2 outcome propagation: force retryResult.status alignment with the
    // corrective retry outcome before downstream consumers see it. See
    // alignRetryResultStatusToOutcome for rationale.
    const resolved: EntityResolveResult = alignRetryResultStatusToOutcome(retryResult, outcome);
    const rankedResults = buildEntityRouteRankedResults(plan, resolved, retryCandidateEntities);
    const laneArtifacts = {
      identity: liftEntityResolveResultToLaneArtifacts(plan, resolved, retryCandidateEntities),
      general: [],
      fused: [],
    };
    const topRankedResult = rankedResults[0];

    pipelineDebug(
      {
        step: PipelineDebugStep.ROUTE_ENTITY_ONLY_DONE,
        resolve_status: resolved.status,
        candidate_count: resolved.candidates.length,
        ranked_count: rankedResults.length,
        corrective_retry: true,
        corrective_retry_outcome: outcome,
        ...(retryCalibratedConfidence !== undefined
          ? { corrective_retry_calibrated_confidence: retryCalibratedConfidence }
          : {}),
        ...(resolved.decisionTrace.outcomeReasonCodes.length > 0
          ? { outcome_reason_codes: resolved.decisionTrace.outcomeReasonCodes }
          : {}),
        ...(topRankedResult !== undefined
          ? {
              top_hard_constraint_pass: topRankedResult.componentScores.hardConstraintPass,
              top_matched_constraints: topRankedResult.matchedConstraints,
              top_unmet_constraints: topRankedResult.unmetConstraints,
              top_evidence_item_count: topRankedResult.evidenceItems.length,
            }
          : {}),
        has_degradation: resolved.degradation !== undefined,
      },
      'pipeline entity-only route',
    );

    return {
      executionTopology: 'entity_only',
      executedPlan: plan,
      executedCompiled: compiled,
      identityResolveResult: resolved,
      fusedResolveResult: resolved,
      laneArtifacts,
      laneTrace: buildSearchExecutionLaneTrace({
        executionTopology: 'entity_only',
        identityResolveResult: resolved,
        fusedResolveResult: resolved,
        laneArtifacts,
      }),
      rankedResults,
      effectiveRetrievalMode: compiled.execution.effectiveRetrievalMode,
      usedCompiledExecution: true,
      retrievalKind: 'entity_lookup',
      sparseExecuted: false,
      specializedRouteExecuted: null,
      ...(retryCalibratedConfidence !== undefined ? { correctiveRetryCalibration: retryCalibratedConfidence } : {}),
    };
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
  ): Promise<readonly CanonicalEntityId[]> {
    if (
      this.deps.blocker === undefined
      || shouldSuppressBlockerSeedExpansion(plan.anchors)
    ) {
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

  private capBlockerSeedIds(
    plan: QueryPlanV1,
    blockerOnlyIds: readonly CanonicalEntityId[],
    compiled: CompiledWineQuery,
  ): readonly CanonicalEntityId[] {
    const maxCandidates = compiled.execution.budget.maxCandidates;

    const anchorCoveredIds = new Set(
      plan.anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
    );
    const remainingSlots = Math.max(0, maxCandidates - anchorCoveredIds.size);
    return blockerOnlyIds.slice(0, remainingSlots);
  }

  private capCorrectiveRetryAdditionalIds(
    plan: QueryPlanV1,
    additionalIds: readonly CanonicalEntityId[],
    pass1BlockerIds: readonly CanonicalEntityId[],
    compiled: CompiledWineQuery,
  ): readonly CanonicalEntityId[] {
    const maxCandidates = compiled.execution.budget.maxCandidates;

    const anchorCoveredIds = new Set(
      plan.anchors.flatMap((anchor) => anchor.candidateEntityIds.map(String)),
    );
    const remainingSlots = Math.max(
      0,
      maxCandidates - anchorCoveredIds.size - new Set(pass1BlockerIds.map(String)).size,
    );
    return additionalIds.slice(0, remainingSlots);
  }

  /**
   * Hybrid route: delegates to the shared pipeline used by HybridUseCase.
   *
   * `/v1/search` auto mode promotes planner-selected hybrid execution onto the
   * dual-lane topology, while explicit hybrid surfaces stay general-only.
   *
   * The resolveEntity callback uses resolveEntityRouteForPlan (single-pass, no
   * TA3 retry loop) because hybrid anchor resolution only needs the pivot
   * entity for retrieval-side orchestration, not full exact-recovery retry.
   * TA3 corrective retry remains entity-only.
   */
  private async executeHybridRoute(
    plan: QueryPlanV1,
    compiled: CompiledWineQuery,
    requestContext?: RequestExecutionContext,
    anchorEntityId?: CanonicalEntityId,
  ): Promise<SearchRouteExecutionResult> {
    const hybridRouteDeps = {
      candidatePool: this.deps.candidatePool,
      browseRetriever: this.deps.browseRetriever,
      compareRetriever: this.deps.compareRetriever,
      entityResolver: this.deps.entityResolver,
      entityLookup: this.deps.entityLookup,
      blocker: this.deps.blocker,
      ranker: this.deps.ranker,
      ...(this.deps.multiQueryGenerator !== undefined
        ? { multiQueryGenerator: this.deps.multiQueryGenerator }
        : {}),
      ...(this.deps.hydeGenerator !== undefined
        ? { hydeGenerator: this.deps.hydeGenerator }
        : {}),
    } as const;

    switch (compiled.execution.executionTopology) {
      case 'dual_lane': {
        const { routeExecution } = await executeDualLaneHybridRoute(
          plan,
          hybridRouteDeps,
          compiled,
          requestContext,
          anchorEntityId,
        );
        return routeExecution;
      }
      case 'general_only': {
        return executeHybridRouteRankingPipeline(
          plan,
          hybridRouteDeps,
          (resolverPlan) => resolveEntityRouteForPlan(
            resolverPlan,
            {
              entityResolver: this.deps.entityResolver,
              entityLookup: this.deps.entityLookup,
              blocker: this.deps.blocker,
            },
            compiled,
          ),
          compiled,
          requestContext,
          anchorEntityId,
        );
      }
      case 'entity_only':
        throw new Error('Hybrid route cannot execute with executionTopology=entity_only');
      default: {
        const _exhaustive: never = compiled.execution.executionTopology;
        throw new Error(`Unhandled hybrid execution topology: ${String(_exhaustive)}`);
      }
    }
  }
}

function emitSearchStageTimingSnapshot(
  stageTimer: SearchExecutionOptions['stageTimer'],
): void {
  if (stageTimer === undefined) {
    return;
  }
  const snapshot = stageTimer.snapshot();
  if (Object.keys(snapshot).length === 0) {
    return;
  }
  pipelineDebug(
    {
      step: PipelineDebugStep.SEARCH_EXECUTE_STAGE_TIMINGS,
      stages: snapshot,
    },
    'pipeline search stage timings',
  );
}

export function buildMixedHybridFallbackExecution(
  fallbackPlan: QueryPlanV1,
  mixedResult: Awaited<ReturnType<MixedSolverPort['solve']>>,
  hybridFallback: SearchRouteExecutionResult,
): SearchRouteExecutionResult {
  const filteredRankedResults = hybridFallback.rankedResults.filter(
    (result) => result.entityId !== mixedResult.anchor.entityId,
  );
  const fusedResolveResult = buildMixedRouteResolveResult(
    fallbackPlan,
    filteredRankedResults,
    mixedResult,
    hybridFallback.executedCompiled.execution.effectiveRetrievalMode,
  );
  const degradationReasons = new Set<string>([
    ...(mixedResult.routeDegradation?.degradationReasons ?? []),
    ...(hybridFallback.routeDegradation?.degradationReasons ?? []),
    MIXED_EMPTY_RESULTS_FALLBACK_REASON,
  ]);

  return {
    ...hybridFallback,
    executedPlan: fallbackPlan,
    fusedResolveResult,
    laneTrace: buildSearchExecutionLaneTrace({
      executionTopology: hybridFallback.executionTopology,
      identityResolveResult: hybridFallback.identityResolveResult,
      fusedResolveResult,
      laneArtifacts: hybridFallback.laneArtifacts,
    }),
    rankedResults: filteredRankedResults,
    decisionContext: {
      ...(hybridFallback.decisionContext ?? {}),
      mixedAnchor: {
        entityId: mixedResult.anchor.entityId,
        canonicalLabel: mixedResult.anchor.canonicalLabel,
        confidence: mixedResult.anchor.anchorConfidence,
      },
    },
    routeDegradation: {
      executionMode: 'degraded',
      degradationReasons: [...degradationReasons],
    },
    fallbackReason: hybridFallback.fallbackReason ?? mixedResult.fallbackReason ?? MIXED_EMPTY_RESULTS_FALLBACK_REASON,
  };
}

export function buildMixedConstraintFallbackExecution(
  plan: QueryPlanV1,
  compiled: CompiledWineQuery,
): { readonly plan: QueryPlanV1; readonly compiled: CompiledWineQuery } {
  const fallbackQuery = buildMixedConstraintFallbackQuery(plan);
  const fallbackQueryViews = buildNormalizedQueryViews(fallbackQuery);
  const fallbackPlan: QueryPlanV1 = {
    ...plan,
    rawQuery: fallbackQuery,
    normalizedQuery: fallbackQueryViews.strict,
    normalizedQueryViews: fallbackQueryViews,
    intent: 'facet_search',
    route: 'hybrid',
    retrievalMode: 'constraint_filter',
    queryClass: 'pure_constraint',
    anchors: [],
    admission_context: {
      requires_identity_seal: false,
      requires_constraint_evidence: plan.constraints.hard.length > 0,
      requires_anchor_evidence: false,
    },
  };

  return {
    plan: fallbackPlan,
    compiled: {
      ...compiled,
      query: {
        ...compiled.query,
        rawQuery: fallbackPlan.rawQuery,
        normalizedQuery: fallbackPlan.normalizedQuery,
        ...(fallbackPlan.normalizedQueryViews !== undefined
          ? { normalizedQueryViews: fallbackPlan.normalizedQueryViews }
          : {}),
        intent: fallbackPlan.intent,
        anchors: [],
        queryClass: fallbackPlan.queryClass,
        constraints: fallbackPlan.constraints,
        retrievalPlan: buildRetrievalPlan(fallbackPlan.constraints),
        retrievalObjective: buildRetrievalObjective(fallbackPlan.constraints),
      },
      execution: {
        ...compiled.execution,
        effectiveRoute: 'hybrid',
        executionTopology: 'general_only',
        effectiveRetrievalMode: 'constraint_filter',
        provenancePolicy: {
          ...compiled.execution.provenancePolicy,
          requireIdentitySeal: false,
          requireAnchorEvidence: false,
        },
      },
    },
  };
}

function buildMixedConstraintFallbackQuery(plan: QueryPlanV1): string {
  const phrases = new Set<string>();
  for (const constraint of plan.constraints.hard) {
    if (constraint.operator === 'exclude') {
      continue;
    }
    const canonicalPhrase = toConstraintFallbackPhrase(constraint.attribute, constraint.value);
    if (canonicalPhrase !== undefined) {
      phrases.add(canonicalPhrase);
      continue;
    }
    const sourcePhrase = constraint.source_phrase.trim();
    if (sourcePhrase.length > 0) {
      phrases.add(sourcePhrase);
    }
  }

  const fallback = [...phrases].join(' ').trim();
  return fallback.length > 0 ? fallback : plan.normalizedQuery;
}

function toConstraintFallbackPhrase(attribute: string, value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  if (attribute === 'wine_type') {
    return `${trimmed} wine`;
  }

  return trimmed;
}
