import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
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
import { executeHybridRouteRankingPipeline } from './search-usecase-hybrid-ranking-pipeline.js';
import {
  buildFailedMixedRouteExecution,
  mixedQueryResultToSearchRouteExecution,
} from './search-usecase-mixed-route.js';
import { buildSearchRouteResolutionContext } from './search-usecase-route-resolution.js';
import { runSearchPostRoutePhase } from './search-usecase-post-route-phase.js';
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
/**
 * Pipeline defect codes that warrant an error-level log before re-throwing.
 * Defined at module scope (Rule 16) — this Set is deterministic and never changes.
 * Policy-blocked and snapshot errors are deliberate signals; only these three
 * indicate upstream defects that need request_id capture.
 */
const PIPELINE_DEFECT_CODES = new Set(['EVIDENCE_OBLIGATION', 'WRONG_RESOLVE', 'BLOCKING_MISS']);

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
      specializedRouteObservability,
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
   * Hybrid route: delegates to the shared pipeline used by HybridUseCase.
   */
  private async executeHybridRoute(
    plan: QueryPlanV1,
    compiled?: CompiledWineQuery,
  ): Promise<SearchRouteExecutionResult> {
    return executeHybridRouteRankingPipeline(
      plan,
      {
        candidatePool: this.deps.candidatePool,
        browseRetriever: this.deps.browseRetriever,
        compareRetriever: this.deps.compareRetriever,
        ranker: this.deps.ranker,
      },
      (p) => this.executeEntityRoute(p),
      compiled,
    );
  }
}
