import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { SnapshotVersions } from './search.usecase.js';
import { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { buildDecisionSnapshotFromRuntimeVersions } from './search-usecase-decision-snapshot.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { QueryEntrySecurityObserver } from '../../infrastructure/observability/query-entry-security-metrics.js';
import type {
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
  DecisionEnginePort,
  EntityDocumentLookupPort,
  EntityResolverPort,
  QueryPlannerPort,
  RankingPort,
  ResponseBuilderPort,
} from './port/search-pipeline-deps.port.js';
import type { HybridSearchRequest } from './hybrid-request.dto.js';
import type { DecomposedSearchUseCasePort } from './port/search-route-usecases.port.js';
import {
  executeHybridRouteRankingPipeline,
  resolveEntityRouteForPlan,
} from './search-usecase-hybrid-ranking-pipeline.js';
import type { SearchRequest } from './search-request.dto.js';
import type { CacheLookupRuntimeState } from './search-usecase-cache-lookup.js';
import { runSearchPostRoutePhase } from './search-usecase-post-route-phase.js';
import { runSearchPreRoutePhase } from './search-usecase-pre-route-phase.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../observability/request-pipeline-debug.js';

export type { HybridSearchRequest } from './hybrid-request.dto.js';

/**
 * Dependencies injected into the HybridUseCase.
 */
export interface HybridUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  readonly candidatePool: CandidatePoolPort;
  readonly browseRetriever?: BrowseRetrieverPort | undefined;
  readonly compareRetriever?: CompareRetrieverPort | undefined;
  readonly entityResolver?: EntityResolverPort | undefined;
  readonly entityLookup?: EntityDocumentLookupPort | undefined;
  readonly ranker: RankingPort;
  readonly decisionEngine: DecisionEnginePort;
  readonly responseBuilder: ResponseBuilderPort;
  readonly snapshotVersions?: SnapshotVersions | undefined;
  readonly drinkingWindow?: DrinkingWindowUseCasePort | undefined;
  /** Shared public query entry guard: Layer 1 sanitizer is required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). */
  readonly injectionJudge?: InjectionJudgePort | undefined;
  readonly judgeFailureMode?: 'fail_open' | 'fail_closed' | undefined;
  readonly queryEntrySecurityObserver?: QueryEntrySecurityObserver | undefined;
  readonly cacheService?: SearchResponseCachePort | undefined;
  readonly cacheLookupRuntimeState?: CacheLookupRuntimeState | undefined;
  readonly cacheLookupRuntimeStateProvider?: (() => CacheLookupRuntimeState) | undefined;
  readonly decomposedSearch?: DecomposedSearchUseCasePort | undefined;
}

/**
 * Hybrid-only use case.
 *
 * Forces route = hybrid while reusing the same ranked-route helpers as the
 * main search pipeline. Specialized hybrid retrieval can still resolve an
 * anchor entity first when compare-style fallback retrieval needs it.
 */
export class HybridUseCase {
  private readonly abstainPolicy = new AbstainPolicy();
  private readonly constraintSAT = new ConstraintSAT();

  constructor(private readonly deps: HybridUseCaseDeps) {}

  async execute(
    request: HybridSearchRequest,
    requestId: string,
  ): Promise<SearchResponseV1 | ComparisonSearchResponse> {
    const startTime = Date.now();
    const searchRequest = toSearchRequest(request);

    pipelineDebug(
      {
        step: 'hybrid.execute.start',
        query_len: request.query.length,
        query_preview: sanitizeQueryForDebug(request.query),
      },
      'pipeline hybrid use case',
    );

    const preRoute = await runSearchPreRoutePhase({
      request: searchRequest,
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

    if (preRoute.outcome === 'return') {
      return preRoute.response;
    }

    const { plan } = preRoute;
    let hybridPipelineResult: Awaited<ReturnType<typeof executeHybridRouteRankingPipeline>>;
    try {
      hybridPipelineResult = await executeHybridRouteRankingPipeline(
        plan,
        {
          candidatePool: this.deps.candidatePool,
          browseRetriever: this.deps.browseRetriever,
          compareRetriever: this.deps.compareRetriever,
          ranker: this.deps.ranker,
        },
        (resolverPlan) => resolveEntityRouteForPlan(resolverPlan, {
          entityResolver: this.deps.entityResolver,
          entityLookup: this.deps.entityLookup,
        }),
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      bootstrapLogger.error(
        { err: errorMessage, requestId },
        '[HybridUseCase] Unexpected error in hybrid ranking pipeline; returning structured failure response',
      );
      pipelineDebug(
        {
          step: 'hybrid.execute.pipeline_error',
          error: errorMessage,
        },
        'pipeline hybrid ranking error',
      );
      const snapshot = buildDecisionSnapshotFromRuntimeVersions(this.deps.snapshotVersions);
      const errorTraceRef = `decision:error:${requestId}`;
      const degradedResponse: SearchResponseV1 = {
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
      return degradedResponse;
    }
    const {
      resolveResult,
      rankedResults,
      decisionContext,
      routeDegradation,
      specializedRouteObservability,
    } = hybridPipelineResult;

    pipelineDebug(
      {
        step: 'hybrid.execute.ranked',
        ranked_count: rankedResults.length,
        resolve_status: resolveResult.status,
        latency_ms_so_far: Date.now() - startTime,
      },
      'pipeline hybrid retrieval+rank done',
    );

    return runSearchPostRoutePhase({
      plan,
      request: searchRequest,
      requestId,
      startTime,
      resolveResult,
      rankedResults,
      decisionContext,
      effectiveRoute: 'hybrid',
      plannerSuggestedMode: plan.route,
      retrievalModeSource: 'api_override',
      abstainPolicy: this.abstainPolicy,
      snapshotVersions: this.deps.snapshotVersions,
      drinkingWindow: this.deps.drinkingWindow,
      decisionEngine: this.deps.decisionEngine,
      responseBuilder: this.deps.responseBuilder,
      cacheService: this.deps.cacheService,
      routeDegradation,
      specializedRouteObservability,
    });
  }
}

function toSearchRequest(request: HybridSearchRequest): SearchRequest {
  return {
    query: request.query,
    ...(request.context !== undefined ? { context: request.context } : {}),
    ...(request.sessionContext !== undefined ? { sessionContext: request.sessionContext } : {}),
    ...(request.queryBudget !== undefined ? { queryBudget: request.queryBudget } : {}),
    ...(request.options !== undefined
      ? {
          options: {
            mode: 'hybrid',
            explain: request.options.explain,
            clarification: request.options.clarification,
          },
        }
      : {}),
    retrieval_mode: 'hybrid',
  };
}
