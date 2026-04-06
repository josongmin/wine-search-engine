import type { PlannerContext } from '../../domain/query/service/planner.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { SnapshotVersions } from './search.usecase.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
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
import { QueryEntrySecurityGate } from './query-entry-security.js';
import { retrieveHybridCandidatesForPlan } from './search-usecase-hybrid-candidates.js';
import { buildHybridRouteResolveResult } from './search-usecase-hybrid-route.js';
import { buildSearchDecisionInput } from './search-usecase-decision-input.js';
import { buildDecisionSnapshotFromPlan } from './search-usecase-decision-snapshot.js';
import { mapRankedResultsToResultItems } from './search-usecase-map-result-items.js';
import { buildResolverCandidatesFromPlan } from './search-usecase-resolver-candidates.js';

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
  /** Shared public query entry guard: Layer 1 sanitizer is required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). */
  readonly injectionJudge?: InjectionJudgePort | undefined;
}

/**
 * Hybrid-only use case.
 *
 * Forces route = hybrid, skipping entity resolution entirely.
 * Pipeline: CandidatePool -> Ranker -> DecisionEngine -> ResponseBuilder.
 */
export class HybridUseCase {
  constructor(private readonly deps: HybridUseCaseDeps) {}

  async execute(
    request: HybridSearchRequest,
    requestId: string,
  ): Promise<SearchResponseV1> {
    const startTime = Date.now();

    const securityGate = new QueryEntrySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
    });
    const effectiveQuery = await securityGate.getSafeQueryOrThrow(request.query);

    // Plan the query
    const plannerContext: PlannerContext = {
      locale: request.context?.locale,
      session: request.sessionContext
        ? {
            sessionId: request.sessionContext.sessionId,
            previousEntities: request.sessionContext.previousEntities as EntityId[],
          }
        : undefined,
      budget: request.queryBudget
        ? {
            maxLatencyMs: request.queryBudget.maxLatencyMs,
            maxCandidates: request.queryBudget.maxCandidates,
            rerankLimit: request.queryBudget.rerankLimit,
          }
        : undefined,
    };

    const plan = await this.deps.queryPlanner.plan(effectiveQuery, plannerContext);

    // Run hybrid retrieval through the same specialized browse/compare entrypoint as SearchUseCase.
    const candidates = await retrieveHybridCandidatesForPlan(
      plan,
      {
        candidatePool: this.deps.candidatePool,
        browseRetriever: this.deps.browseRetriever,
        compareRetriever: this.deps.compareRetriever,
      },
      async (resolverPlan) => {
        if (this.deps.entityResolver === undefined) {
          return {
            status: 'failed' as const,
            candidates: [],
            decisionTrace: {
              queryClass: resolverPlan.queryClass,
              top1CalibratedScore: 0,
              top2CalibratedScore: 0,
              calibratedGap: 0,
              decisionConfidenceC: 0,
              ambiguityDetected: false,
              ambiguityTypes: [],
              appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
              outcomeReasonCodes: ['HYBRID_ROUTE_MISSING_ENTITY_RESOLVER'],
            },
            conformalSetSize: 1,
          };
        }

        const candidateEntities = await buildResolverCandidatesFromPlan(
          resolverPlan,
          this.deps.entityLookup,
        );

        return this.deps.entityResolver.resolve({
          rawQuery: resolverPlan.rawQuery,
          normalizedQuery: resolverPlan.normalizedQuery,
          ...(resolverPlan.normalizedQueryViews !== undefined
            ? { normalizedQueryViews: resolverPlan.normalizedQueryViews }
            : {}),
          queryClass: resolverPlan.queryClass,
          policy: resolverPlan.policy,
          anchorCandidates: resolverPlan.anchors,
          uncertainty: resolverPlan.uncertainty,
          candidateEntities,
        });
      },
    );

    // Rank candidates
    const rankingInput: RankingInput = {
      queryPlan: plan,
      candidates,
      constraints: plan.constraints,
    };

    const rankedResults = await this.deps.ranker.rank(rankingInput);
    const resolveResult = buildHybridRouteResolveResult(plan, rankedResults);

    // Build decision input
    const decisionInput = buildSearchDecisionInput(
      plan,
      resolveResult,
      rankedResults,
      'hybrid',
    );

    // Build snapshot and decide
    const snapshot: DecisionSnapshot = buildDecisionSnapshotFromPlan(
      plan,
      this.deps.snapshotVersions,
    );

    const decisionOutput = await this.deps.decisionEngine.decide(decisionInput, snapshot);

    // Build response
    const queryTimeMs = Date.now() - startTime;
    const results = await mapRankedResultsToResultItems(rankedResults, undefined);

    return this.deps.responseBuilder.build({
      decisionOutput,
      queryPlan: plan,
      results,
      requestId,
      queryTimeMs,
      route: 'hybrid',
    });
  }
}
