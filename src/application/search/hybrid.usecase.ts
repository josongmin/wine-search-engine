import type { PlannerContext } from '../../domain/query/service/planner.js';
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
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type {
  CandidatePoolPort,
  DecisionEnginePort,
  QueryPlannerPort,
  RankingPort,
  ResponseBuilderPort,
} from './port/search-pipeline-deps.port.js';
import type { HybridSearchRequest } from './hybrid-request.dto.js';
import { QueryEntrySecurityGate } from './query-entry-security.js';

export type { HybridSearchRequest } from './hybrid-request.dto.js';

/**
 * Dependencies injected into the HybridUseCase.
 */
export interface HybridUseCaseDeps {
  readonly queryPlanner: QueryPlannerPort;
  readonly candidatePool: CandidatePoolPort;
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
    let effectiveQuery = request.query;

    const securityGate = new QueryEntrySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
    });
    const securityResult = await securityGate.getSafeQueryOrSearchRejection(
      request.query,
      requestId,
      startTime,
    );
    if ('rejection' in securityResult) {
      return securityResult.rejection;
    }
    effectiveQuery = securityResult.sanitizedQuery;

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
      queryPlan: plan,
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
    const currentYear = new Date().getFullYear();

    return rankedResults.map((r) => {
      // Build drinking window block if data is available
      const drinkingWindow =
        r.drinkingWindowStart !== undefined && r.drinkingWindowEnd !== undefined
          ? {
              drinkingWindowStart: r.drinkingWindowStart,
              drinkingWindowEnd: r.drinkingWindowEnd,
              currentlyDrinkable:
                currentYear >= r.drinkingWindowStart &&
                currentYear <= r.drinkingWindowEnd,
              confidence: 'high' as const,
            }
          : undefined;

      return {
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
            preferenceAlignment: r.componentScores.preferenceAlignment,
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
        ...(drinkingWindow !== undefined ? { drinkingWindow } : {}),
      };
    });
  }
}
