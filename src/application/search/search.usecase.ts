import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { QueryClassWeights } from '../../domain/ranking/index.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { QueryEntrySecurityObserver } from '../../infrastructure/observability/query-entry-security-metrics.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../observability/request-pipeline-debug.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { buildDecisionSnapshotFromRuntimeVersions } from './search-usecase-decision-snapshot.js';
import { buildInternalErrorAuthorityTraceRef } from '../../domain/decision/service/authority-trace.js';
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
import { runHybridRankingPipeline } from './search-usecase-hybrid-ranking-pipeline.js';
import {
  buildFailedMixedRouteExecution,
  mixedQueryResultToSearchRouteExecution,
} from './search-usecase-mixed-route.js';
import { buildSearchRouteResolutionContext } from './search-usecase-route-resolution.js';
import { runSearchPostRoutePhase } from './search-usecase-post-route-phase.js';
import { retrieveHybridCandidatesForPlan } from './search-usecase-hybrid-candidates.js';
import { buildResolverCandidatesFromPlan } from './search-usecase-resolver-candidates.js';
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
      // Known domain errors (PolicyBlockedError, WrongResolveError, etc.) are deliberate
      // pipeline signals — propagate them so the caller can handle them correctly.
      if (err instanceof DomainError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      bootstrapLogger.error(
        { err: errorMessage, requestId },
        '[SearchUseCase] Unexpected error in execute pipeline; returning structured failure response',
      );
      pipelineDebug(
        {
          step: 'search.execute.unexpected_error',
          error: errorMessage,
        },
        'pipeline search.execute error',
      );

      const snapshot = buildDecisionSnapshotFromRuntimeVersions(this.deps.snapshotVersions);
      const errorTraceRef = buildInternalErrorAuthorityTraceRef({
        snapshot,
        requestId,
        failureReason: 'INTERNAL_INCONSISTENCY',
      });

      const response: SearchResponseV1 = {
        queryType: 'search',
        engineDecision: {
          decisionStatus: 'failed',
          nextAction: 'fail',
          route: 'error',
          decisionConfidence: 0,
          confidenceSemantics: 'calibrated_decision_confidence',
          decisionTraceRef: errorTraceRef,
          decisionSnapshot: snapshot,
          executionMode: 'degraded',
          blockingEligible: false,
          failure_reason: 'INTERNAL_INCONSISTENCY',
        },
        results: [],
        meta: {
          requestId,
          queryTimeMs: Date.now() - startTime,
          route: 'error',
          version: '1.0.0',
          engine_schema_version: 'search_response_v1',
          decisionSnapshot: snapshot,
          authorityTraceRef: errorTraceRef,
          runtimeCorrelationRef: requestId,
          executionMode: 'degraded',
          blockingEligible: false,
        },
      };

      return { response };
    }
  }

  private async executeInternalUnsafe(
    request: SearchRequest,
    requestId: string,
    includeEvalProvenance: boolean,
    startTime: number,
    options?: SearchExecutionOptions,
  ): Promise<SearchExecutorEvaluationResult> {
    if (options?.abortSignal?.aborted) {
      const error = new Error('Search execution aborted');
      error.name = 'AbortError';
      throw error;
    }

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

    if (options?.abortSignal?.aborted) {
      const error = new Error('Search execution aborted');
      error.name = 'AbortError';
      throw error;
    }

    if (preRoute.outcome === 'return') {
      pipelineDebug(
        {
          step: 'search.pre_route.early_exit',
          query_type: preRoute.response.queryType,
        },
        'pipeline pre_route return',
      );
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
      specializedRouteObservability,
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

    // TODO: options.explain and options.clarification are not yet implemented in the main search path.
    // When implemented, they should be forwarded to ResponseBuilder.build() and/or the DecisionEngine.

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
      specializedRouteObservability,
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
   * Entity-only route: run EntityResolver directly.
   */
  // NOTE: compiled (CompiledWineQuery) is intentionally not passed to the entity route.
  // Entity resolution uses QueryPlanV1 policy fields directly (requireExact, allowApproximate).
  // compiled.execution.budget and provenancePolicy are NOT applied to entity queries.
  // To extend compiled-first semantics to entity route, thread compiled through EntityResolver.
  private async executeEntityRoute(plan: QueryPlanV1): Promise<EntityResolveResult> {
    const candidateEntities = await buildResolverCandidatesFromPlan(plan, this.deps.entityLookup);

    pipelineDebug(
      {
        step: 'route.entity.only.start',
        query_class: plan.queryClass,
        resolver_candidate_count: candidateEntities.length,
      },
      'pipeline entity-only route',
    );

    const resolved = await this.deps.entityResolver.resolve({
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

    pipelineDebug(
      {
        step: 'route.entity.only.done',
        resolve_status: resolved.status,
        candidate_count: resolved.candidates.length,
        has_degradation: resolved.degradation !== undefined,
      },
      'pipeline entity-only route',
    );

    return resolved;
  }

  /**
   * Hybrid route: CandidatePool -> Ranker -> build resolve result.
   */
  private async executeHybridRoute(
    plan: QueryPlanV1,
    compiled?: CompiledWineQuery,
  ): Promise<{
    resolveResult: EntityResolveResult;
    rankedResults: readonly RankedResult[];
    routeDegradation?: SearchRouteExecutionResult['routeDegradation'];
    funnelMetrics?: SearchRouteExecutionResult['funnelMetrics'];
    specializedRouteObservability?: SearchRouteExecutionResult['specializedRouteObservability'];
  }> {
    const retrieval = await retrieveHybridCandidatesForPlan(
      plan,
      {
        candidatePool: this.deps.candidatePool,
        browseRetriever: this.deps.browseRetriever,
        compareRetriever: this.deps.compareRetriever,
      },
      (p) => this.executeEntityRoute(p),
      compiled,
    );

    const ranked = await runHybridRankingPipeline(
      plan,
      retrieval.candidates,
      this.deps.ranker,
      compiled,
    );

    if (retrieval.routeDegradation === undefined) {
      return {
        ...ranked,
        ...(retrieval.specializedRouteObservability !== undefined
          ? { specializedRouteObservability: retrieval.specializedRouteObservability }
          : {}),
      };
    }

    return {
      ...ranked,
      routeDegradation: ranked.routeDegradation === undefined
        ? retrieval.routeDegradation
        : {
            executionMode: 'degraded',
            degradationReasons: [
              ...new Set([
                ...ranked.routeDegradation.degradationReasons,
                ...retrieval.routeDegradation.degradationReasons,
              ]),
            ],
          },
      ...(retrieval.specializedRouteObservability !== undefined
        ? { specializedRouteObservability: retrieval.specializedRouteObservability }
        : {}),
    };
  }
}
