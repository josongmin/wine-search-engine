import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
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
import { dispatchSearchRouteExecution } from './search-usecase-route-dispatch.js';
import { runSearchPreRoutePhase } from './search-usecase-pre-route-phase.js';
import type { DecomposedSearchUseCasePort } from './port/search-route-usecases.port.js';
import type { SearchRequest } from './search-request.dto.js';
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
import { mixedQueryResultToSearchRouteExecution } from './search-usecase-mixed-route.js';
import { buildSearchRouteResolutionContext } from './search-usecase-route-resolution.js';
import { runSearchPostRoutePhase } from './search-usecase-post-route-phase.js';
import { retrieveHybridCandidatesForPlan } from './search-usecase-hybrid-candidates.js';
import { buildResolverCandidatesFromPlan } from './search-usecase-resolver-candidates.js';

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
  ): Promise<SearchResponseV1 | ComparisonSearchResponse> {
    const startTime = Date.now();

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
      decomposedSearch: this.deps.decomposedSearch,
    });

    if (preRoute.outcome === 'return') {
      return preRoute.response;
    }

    const { plan } = preRoute;

    // Step 2: Determine effective route (top-level retrieval_mode takes precedence)
    const {
      effectiveRoute,
      plannerSuggestedMode,
      retrievalModeSource,
    } = buildSearchRouteResolutionContext(plan, request);

    // Step 3: Execute based on route
    const { resolveResult, rankedResults } = await dispatchSearchRouteExecution(
      effectiveRoute,
      {
        executeEntity: () => this.executeEntityRoute(plan),
        executeHybrid: () => this.executeHybridRoute(plan),
        executeMixed: async () => {
          const mixedResult = await this.deps.mixedSolver.solve(plan);
          return mixedQueryResultToSearchRouteExecution(plan, mixedResult);
        },
      },
    );

    // Steps 3b–7: Entropy abstain (RFC-013) → DecisionEngine → response → cache write
    return runSearchPostRoutePhase({
      plan,
      request,
      requestId,
      startTime,
      resolveResult,
      rankedResults,
      effectiveRoute,
      plannerSuggestedMode,
      retrievalModeSource,
      abstainPolicy: this.abstainPolicy,
      snapshotVersions: this.deps.snapshotVersions,
      drinkingWindow: this.deps.drinkingWindow,
      decisionEngine: this.deps.decisionEngine,
      responseBuilder: this.deps.responseBuilder,
      cacheService: this.deps.cacheService,
    });
  }

  /**
   * Entity-only route: run EntityResolver directly.
   */
  private async executeEntityRoute(plan: QueryPlanV1): Promise<EntityResolveResult> {
    const candidateEntities = await buildResolverCandidatesFromPlan(plan, this.deps.entityLookup);

    return this.deps.entityResolver.resolve({
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
  }

  /**
   * Hybrid route: CandidatePool -> Ranker -> build resolve result.
   */
  private async executeHybridRoute(
    plan: QueryPlanV1,
  ): Promise<{ resolveResult: EntityResolveResult; rankedResults: readonly RankedResult[] }> {
    const candidates = await retrieveHybridCandidatesForPlan(
      plan,
      {
        candidatePool: this.deps.candidatePool,
        browseRetriever: this.deps.browseRetriever,
        compareRetriever: this.deps.compareRetriever,
      },
      (p) => this.executeEntityRoute(p),
    );

    return runHybridRankingPipeline(plan, candidates, this.deps.ranker, this.deps.ltrModels);
  }
}
