import type { Planner, PlannerContext } from '../../domain/query/service/planner.js';
import type { CandidatePoolService } from '../../domain/retrieval/service/candidate-pool.js';
import type { Ranker } from '../../domain/ranking/service/ranker.js';
import type { DecisionEngine } from '../../domain/decision/service/decision-engine.js';
import type { ResponseBuilder } from '../../domain/response/service/response-builder.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { DecisionInput } from '../../domain/decision/model/decision-input.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../domain/resolver/service/resolver.js';
import type { ResultItem } from '../../domain/response/model/result-item.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { SnapshotVersions } from './search.usecase.js';

/**
 * Hybrid search request shape.
 */
export interface HybridSearchRequest {
  readonly query: string;
  readonly context?: {
    readonly locale: string;
    readonly currency: string;
  } | undefined;
  readonly sessionContext?: {
    readonly sessionId: string;
    readonly previousEntities: string[];
  } | undefined;
  readonly queryBudget?: {
    readonly maxLatencyMs: number;
    readonly maxCandidates: number;
    readonly rerankLimit: number;
  } | undefined;
  readonly options?: {
    readonly explain: boolean;
    readonly clarification: boolean;
  } | undefined;
}

/**
 * Dependencies injected into the HybridUseCase.
 */
export interface HybridUseCaseDeps {
  readonly queryPlanner: Planner;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: Ranker;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly snapshotVersions?: SnapshotVersions | undefined;
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

    const plan = await this.deps.queryPlanner.plan(request.query, plannerContext);

    // Build retrieval input (force hybrid route)
    const retrievalInput: HybridRetrievalInput = {
      queryPlan: plan,
      route: 'hybrid',
      lexicalQueries: [plan.normalizedQuery],
      semanticQueries: [plan.rawQuery],
      hardConstraints: plan.constraints.hard,
      softConstraints: plan.constraints.soft,
    };

    // Run hybrid retrieval
    const candidates = await this.deps.candidatePool.generate(retrievalInput);

    // Rank candidates
    const rankingInput: RankingInput = {
      queryPlan: plan,
      candidates,
      constraints: plan.constraints,
    };

    const rankedResults = await this.deps.ranker.rank(rankingInput);

    // Build a synthetic resolve result for the hybrid path
    const top1Score = rankedResults[0]?.finalScore ?? 0;
    const top2Score = rankedResults[1]?.finalScore ?? 0;
    const hybridDecisionC = Math.max(0, Math.min(1, top1Score));
    const hybridGap = Math.max(0, Math.min(1, top1Score - top2Score));
    const resolveResult: EntityResolveResult = {
      status: rankedResults.length > 0 ? 'resolved' : 'failed',
      candidates: [],
      decisionConfidenceC: hybridDecisionC,
      decisionTrace: {
        queryClass: plan.queryClass,
        top1CalibratedScore: hybridDecisionC,
        top2CalibratedScore: Math.max(0, Math.min(1, top2Score)),
        calibratedGap: hybridGap,
        decisionConfidenceC: hybridDecisionC,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: ['HYBRID_ONLY_ROUTE'],
      },
      conformalSetSize: computeConformalSetSize(hybridDecisionC, DEFAULT_ALPHA, rankedResults.length),
    };

    // Build decision input
    const decisionInput: DecisionInput = {
      queryPlan: plan,
      resolverResult: resolveResult,
      policy: plan.policy,
      uncertainty: plan.uncertainty,
    };

    // Build snapshot and decide
    const snapshot: DecisionSnapshot = {
      model_versions: this.deps.snapshotVersions?.modelVersions ?? {},
      index_versions: this.deps.snapshotVersions?.indexVersions ?? {},
      policy_rule_version: plan.policyRuleVersion,
      threshold_profile_id: plan.thresholdProfileId,
      planner_version: plan.plannerVersion,
      feature_flags: {},
    };

    const decisionOutput = await this.deps.decisionEngine.decide(decisionInput, snapshot);

    // Build response
    const queryTimeMs = Date.now() - startTime;
    const results = this.mapRankedToResultItems(rankedResults);

    return this.deps.responseBuilder.build({
      decisionOutput,
      results,
      requestId,
      queryTimeMs,
      route: 'hybrid',
    });
  }

  /**
   * Maps ranked results to response-level ResultItems.
   */
  private mapRankedToResultItems(rankedResults: readonly RankedResult[]): readonly ResultItem[] {
    return rankedResults.map((r) => ({
      entity: {
        entityId: r.entityId,
        canonicalLabel: r.canonicalLabel,
        type: 'wine',
      },
      relevanceScore: r.finalScore,
      match: {
        matchType: 'hybrid' as const,
        scoreComponents: {
          lexical: 0,
          semantic: r.componentScores.semantic,
          attribute: r.componentScores.attributeAlignment,
          popularity: r.componentScores.popularity,
        },
      },
      constraints: {
        matched: [],
        unmet: [],
        inferred: [],
      },
      uncertainty: {
        uncertaintyConfidence: 1 - r.componentScores.uncertaintyPenalty,
        missingInfo: [],
        approximationUsed: false,
      },
      evidenceItems: r.evidenceItems,
    }));
  }
}
