import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { SnapshotVersions } from './search.usecase.js';
import { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import type { QueryEntrySecurityObserver } from '../../domain/security/port/security-observer.port.js';
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
import type {
  DecomposedSearchUseCasePort,
  HybridExecutionOptions,
} from './port/search-route-usecases.port.js';
import {
  executeHybridRouteRankingPipeline,
  resolveEntityRouteForPlan,
} from './search-usecase-hybrid-ranking-pipeline.js';
import type { SearchRequest } from './search-request.dto.js';
import type { CacheLookupRuntimeState } from './search-usecase-cache-lookup.js';
import { runSearchPostRoutePhase } from './search-usecase-post-route-phase.js';
import { runSearchPreRoutePhase } from './search-usecase-pre-route-phase.js';
import { pipelineDebug, sanitizeQueryForDebug } from '../../observability/request-pipeline-debug.js';
import { DomainError } from '../../domain/shared/error/domain-error.js';
import { isAbortError, throwIfAborted } from '../../domain/shared/cooperative-abort.js';
import { createStageTimer } from '../../observability/stage-timer.js';
/**
 * Dependencies injected into the HybridUseCase.
 */
interface HybridUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  /**
   * Explicit test / special-seam escape hatch for planners that only implement
   * plan(). Production wiring must leave this unset.
   */
  readonly allowCompiledFallback?: boolean | undefined;
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
    options?: HybridExecutionOptions,
  ): Promise<SearchResponseV1 | ComparisonSearchResponse> {
    throwIfAborted(options?.abortSignal, 'Hybrid search execution aborted');

    const startTime = Date.now();
    const searchRequest = toSearchRequest(request);
    // Per-request stage timer. Threaded through the retrieval pipeline so
    // CandidatePool can record per-channel latency under stable stage names.
    // Snapshot is emitted via pipelineDebug at the end so callers reading
    // the structured log can attribute time without scraping interleaved lines.
    const stageTimer = createStageTimer();
    stageTimer.start('hybrid.total');

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
      ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
      stageTimer,
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
      allowCompiledFallback: this.deps.allowCompiledFallback,
    });

    throwIfAborted(options?.abortSignal, 'Hybrid search execution aborted');

    if (preRoute.outcome === 'return') {
      return preRoute.response;
    }

    const { plan, compiled } = preRoute;
    let hybridPipelineResult: Awaited<ReturnType<typeof executeHybridRouteRankingPipeline>>;
    try {
      stageTimer.start('hybrid.retrieval_and_ranking');
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
        }, compiled),
        compiled,
        {
          stageTimer,
          ...(options?.abortSignal !== undefined ? { abortSignal: options.abortSignal } : {}),
          requestId,
        },
      );
      stageTimer.end('hybrid.retrieval_and_ranking');
    } catch (err) {
      // Propagate domain errors and abort signals to the global error handler
      // so they receive the correct HTTP status (e.g. 403 for POLICY_BLOCKED).
      if (err instanceof DomainError) throw err;
      if (isAbortError(err)) throw err;

      const errorMessage = err instanceof Error ? err.message : String(err);
      bootstrapLogger.error(
        { err: errorMessage, requestId },
        '[HybridUseCase] Unexpected error in hybrid ranking pipeline — propagating as 500',
      );
      throw new DomainError(
        'INTERNAL_INCONSISTENCY',
        `Hybrid pipeline failed unexpectedly: ${errorMessage}`,
      );
    }
    const {
      resolveResult,
      rankedResults,
      decisionContext,
      routeDegradation,
      rankingMetadata,
      effectiveRetrievalMode,
      retrievalKind,
      sparseExecuted,
      specializedRouteExecuted,
      usedCompiledExecution,
      specializedRouteObservability,
      retrievalFusionTrace,
      hardFilterDropLog,
    } = hybridPipelineResult;

    throwIfAborted(options?.abortSignal, 'Hybrid search execution aborted');

    pipelineDebug(
      {
        step: 'hybrid.execute.ranked',
        ranked_count: rankedResults.length,
        resolve_status: resolveResult.status,
        latency_ms_so_far: Date.now() - startTime,
      },
      'pipeline hybrid retrieval+rank done',
    );

    stageTimer.end('hybrid.total');
    pipelineDebug(
      {
        step: 'hybrid.execute.stage_timings',
        stages: stageTimer.snapshot(),
      },
      'pipeline hybrid stage timings',
    );

    return runSearchPostRoutePhase({
      plan,
      compiled,
      request: searchRequest,
      requestId,
      startTime,
      resolveResult,
      rankedResults,
      decisionContext,
      // HybridUseCase always forces hybrid route — this is an API-level override.
      effectiveRoute: 'hybrid',
      plannerSuggestedMode: compiled.execution.effectiveRetrievalMode,
      retrievalModeSource: 'api_override',
      abstainPolicy: this.abstainPolicy,
      snapshotVersions: this.deps.snapshotVersions,
      drinkingWindow: this.deps.drinkingWindow,
      decisionEngine: this.deps.decisionEngine,
      responseBuilder: this.deps.responseBuilder,
      cacheService: this.deps.cacheService,
      routeDegradation,
      effectiveRetrievalMode,
      retrievalKind,
      sparseExecuted,
      specializedRouteExecuted,
      usedCompiledExecution,
      ...(rankingMetadata !== undefined ? { rankingMetadata } : {}),
      specializedRouteObservability,
      ...(retrievalFusionTrace !== undefined ? { retrievalFusionTrace } : {}),
      ...(hardFilterDropLog !== undefined && hardFilterDropLog.length > 0
        ? { hardFilterDropLog }
        : {}),
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
