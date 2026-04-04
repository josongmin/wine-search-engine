import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { PlannerContext } from '../../domain/query/service/planner.js';
import type { Planner } from '../../domain/query/service/planner.js';
import type { Resolver, ResolverInput } from '../../domain/resolver/service/resolver.js';
import type { CandidatePoolService } from '../../domain/retrieval/service/candidate-pool.js';
import type { Ranker } from '../../domain/ranking/service/ranker.js';
import type { DecisionEngine } from '../../domain/decision/service/decision-engine.js';
import type { ResponseBuilder } from '../../domain/response/service/response-builder.js';
import type { MixedSolver } from '../../domain/mixed/service/mixed-solver.js';
import type { DecisionInput } from '../../domain/decision/model/decision-input.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { ResultItem } from '../../domain/response/model/result-item.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { EntityId } from '../../domain/shared/types/index.js';

/**
 * Incoming search request shape.
 */
export interface SearchRequest {
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
    readonly mode: 'auto' | 'entity' | 'hybrid' | 'mixed';
    readonly explain: boolean;
    readonly clarification: boolean;
  } | undefined;
}

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
  readonly queryPlanner: Planner;
  readonly entityResolver: Resolver;
  readonly candidatePool: CandidatePoolService;
  readonly ranker: Ranker;
  readonly decisionEngine: DecisionEngine;
  readonly responseBuilder: ResponseBuilder;
  readonly mixedSolver: MixedSolver;
  /** Version strings for RFC-015 snapshot population. */
  readonly snapshotVersions?: SnapshotVersions | undefined;
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
  constructor(private readonly deps: SearchUseCaseDeps) {}

  async execute(
    request: SearchRequest,
    requestId: string,
  ): Promise<SearchResponseV1> {
    const startTime = Date.now();

    // Step 1: Plan the query
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

    // Step 2: Determine effective route
    const effectiveRoute = this.resolveRoute(plan, request.options?.mode);

    // Step 3: Execute based on route
    let resolveResult: EntityResolveResult;
    let rankedResults: readonly RankedResult[] = [];

    switch (effectiveRoute) {
      case 'entity': {
        resolveResult = await this.executeEntityRoute(plan);
        break;
      }
      case 'hybrid': {
        const hybridResult = await this.executeHybridRoute(plan);
        resolveResult = hybridResult.resolveResult;
        rankedResults = hybridResult.rankedResults;
        break;
      }
      case 'mixed': {
        const mixedResult = await this.deps.mixedSolver.solve(plan);
        rankedResults = mixedResult.rankedResults;
        // Build a synthetic resolve result for the mixed path
        resolveResult = {
          status: rankedResults.length > 0 ? 'resolved' : 'failed',
          candidates: [],
          decisionConfidenceC: mixedResult.anchor.anchorConfidence,
          decisionTrace: {
            queryClass: plan.queryClass,
            top1CalibratedScore: mixedResult.anchor.anchorConfidence,
            top2CalibratedScore: 0,
            calibratedGap: mixedResult.anchor.anchorConfidence,
            decisionConfidenceC: mixedResult.anchor.anchorConfidence,
            ambiguityDetected: false,
            ambiguityTypes: [],
            appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
            outcomeReasonCodes: ['MIXED_ROUTE'],
          },
        };
        break;
      }
    }

    // Step 4: Build DecisionInput
    const decisionInput = this.buildDecisionInput(plan, resolveResult);

    // Step 5: Build snapshot & run DecisionEngine
    const snapshot = this.buildSnapshot(plan);
    const decisionOutput = await this.deps.decisionEngine.decide(decisionInput, snapshot);

    // Step 6: Build response
    const queryTimeMs = Date.now() - startTime;
    const results = this.mapRankedToResultItems(rankedResults);

    const response = this.deps.responseBuilder.build({
      decisionOutput,
      results,
      requestId,
      queryTimeMs,
      route: effectiveRoute,
    });

    return response;
  }

  /**
   * Determines the effective query route based on mode override or planner decision.
   */
  private resolveRoute(
    plan: QueryPlanV1,
    mode?: 'auto' | 'entity' | 'hybrid' | 'mixed',
  ): QueryRoute {
    if (mode === undefined || mode === 'auto') {
      return plan.route;
    }
    return mode;
  }

  /**
   * Entity-only route: run EntityResolver directly.
   */
  private async executeEntityRoute(plan: QueryPlanV1): Promise<EntityResolveResult> {
    const resolverInput: ResolverInput = {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      queryClass: plan.queryClass,
      policy: plan.policy,
      anchorCandidates: plan.anchors,
      uncertainty: plan.uncertainty,
      candidateEntities: [],
    };
    return this.deps.entityResolver.resolve(resolverInput);
  }

  /**
   * Hybrid route: CandidatePool -> Ranker -> build resolve result.
   */
  private async executeHybridRoute(
    plan: QueryPlanV1,
  ): Promise<{ resolveResult: EntityResolveResult; rankedResults: readonly RankedResult[] }> {
    // Build retrieval input from the plan
    const retrievalInput: HybridRetrievalInput = {
      queryPlan: plan,
      route: 'hybrid',
      lexicalQueries: [plan.normalizedQuery],
      semanticQueries: [plan.rawQuery],
      hardConstraints: plan.constraints.hard,
      softConstraints: plan.constraints.soft,
    };

    const candidates = await this.deps.candidatePool.generate(retrievalInput);

    // Rank the candidates
    const rankingInput: RankingInput = {
      queryPlan: plan,
      candidates,
      constraints: plan.constraints,
    };

    const rankedResults = await this.deps.ranker.rank(rankingInput);

    // Build a synthetic resolve result for the hybrid path.
    // Use the top-ranked result's finalScore as the raw decision confidence,
    // clamped to [0, 1]. Hardcoding 0.5 is wrong: it always falls below
    // resolveTau (≥0.60) for most query classes, causing every hybrid search
    // to return ambiguous regardless of ranking quality.
    const top1Score = rankedResults[0]?.finalScore ?? 0;
    const top2Score = rankedResults[1]?.finalScore ?? 0;
    const hybridConfidence = Math.max(0, Math.min(1, top1Score));
    const hybridGap = Math.max(0, Math.min(1, top1Score - top2Score));

    const resolveResult: EntityResolveResult = {
      status: rankedResults.length > 0 ? 'resolved' : 'failed',
      candidates: [],
      decisionConfidenceC: hybridConfidence,
      decisionTrace: {
        queryClass: plan.queryClass,
        top1CalibratedScore: hybridConfidence,
        top2CalibratedScore: Math.max(0, Math.min(1, top2Score)),
        calibratedGap: hybridGap,
        decisionConfidenceC: hybridConfidence,
        ambiguityDetected: false,
        ambiguityTypes: [],
        appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
        outcomeReasonCodes: ['HYBRID_ROUTE'],
      },
    };

    return { resolveResult, rankedResults };
  }

  /**
   * Assembles DecisionInput from plan and resolver result.
   */
  private buildDecisionInput(
    plan: QueryPlanV1,
    resolverResult: EntityResolveResult,
  ): DecisionInput {
    return {
      queryPlan: plan,
      resolverResult,
      policy: plan.policy,
      uncertainty: plan.uncertainty,
    };
  }

  /**
   * Builds a DecisionSnapshot from the current plan state.
   * Populates model_versions and index_versions from injected snapshotVersions
   * per RFC-015, which requires actual version strings (not empty objects).
   */
  private buildSnapshot(plan: QueryPlanV1): DecisionSnapshot {
    return {
      model_versions: this.deps.snapshotVersions?.modelVersions ?? {},
      index_versions: this.deps.snapshotVersions?.indexVersions ?? {},
      policy_rule_version: plan.policyRuleVersion,
      threshold_profile_id: plan.thresholdProfileId,
      planner_version: plan.plannerVersion,
      feature_flags: {},
    };
  }

  /**
   * Maps ranked results to response-level ResultItems.
   */
  private mapRankedToResultItems(rankedResults: readonly RankedResult[]): readonly ResultItem[] {
    return rankedResults.map((r) => ({
      entity: {
        entityId: r.entityId,
        canonicalLabel: '',
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
