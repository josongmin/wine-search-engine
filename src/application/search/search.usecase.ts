import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { PlannerContext } from '../../domain/query/service/planner.js';
import type { Planner } from '../../domain/query/service/planner.js';
import type { Resolver, ResolverInput } from '../../domain/resolver/service/resolver.js';
import type { CandidatePoolService } from '../../domain/retrieval/service/candidate-pool.js';
import type { Ranker } from '../../domain/ranking/service/ranker.js';
import type { DecisionEngine } from '../../domain/decision/service/decision-engine.js';
import type { ResponseBuilder } from '../../domain/response/service/response-builder.js';
import type { MixedSolver } from '../../domain/mixed/service/mixed-solver.js';
import type { DecisionInput, EvidenceSummary } from '../../domain/decision/model/decision-input.js';
import type { DecisionSnapshot, SignalSet } from '../../domain/shared/types/index.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { ResultItem } from '../../domain/response/model/result-item.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../domain/resolver/service/resolver.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { CounterfactualReject } from '../../domain/response/model/counterfactual.js';
import type { DrinkingWindowUseCase } from '../drinking-window/drinking-window.usecase.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { LLMInjectionJudge } from '../../domain/security/service/llm-injection-judge.js';

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
  /** Drinking window predictor for wine aging insights (Epic 15). */
  readonly drinkingWindow?: DrinkingWindowUseCase | undefined;
  /** Version strings for RFC-015 snapshot population. */
  readonly snapshotVersions?: SnapshotVersions | undefined;
  /** Layer 1: Static pattern-based injection sanitizer (Epic 16.1). Required. */
  readonly querySanitizer: QuerySanitizer;
  /** Layer 2: LLM-based injection judge for borderline queries (Epic 16.1). Optional. */
  readonly injectionJudge?: LLMInjectionJudge | undefined;
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

    // Step 0: Layer 1 injection defense (static patterns)
    const sanitizationResult = this.deps.querySanitizer.sanitize(request.query);
    if (!sanitizationResult.safe) {
      return this.buildInjectionRejection(requestId, startTime, 'LAYER_1_BLOCKED', sanitizationResult.reason);
    }

    const sanitizedQuery = sanitizationResult.sanitizedQuery;

    // Step 0b: Layer 2 injection defense (LLM judge) for borderline cases
    // Only invoked if sanitizer passed and judge is available
    if (this.deps.injectionJudge !== undefined) {
      try {
        const isInjection = await this.deps.injectionJudge.judge(sanitizedQuery);
        if (isInjection) {
          return this.buildInjectionRejection(requestId, startTime, 'LAYER_2_BLOCKED', 'LLM_JUDGE_REJECTION');
        }
      } catch (err) {
        // LLM judge failure — log and continue (fail open for availability)
        console.error('[SearchUseCase] LLM judge error:', err);
      }
    }

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

    const plan = await this.deps.queryPlanner.plan(sanitizedQuery, plannerContext);

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
        const mixedDecisionC = mixedResult.anchor.anchorConfidence;
        resolveResult = {
          status: rankedResults.length > 0 ? 'resolved' : 'failed',
          candidates: [],
          decisionConfidenceC: mixedDecisionC,
          decisionTrace: {
            queryClass: plan.queryClass,
            top1CalibratedScore: mixedDecisionC,
            top2CalibratedScore: 0,
            calibratedGap: mixedDecisionC,
            decisionConfidenceC: mixedDecisionC,
            ambiguityDetected: false,
            ambiguityTypes: [],
            appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
            outcomeReasonCodes: ['MIXED_ROUTE'],
          },
          conformalSetSize: computeConformalSetSize(mixedDecisionC, DEFAULT_ALPHA, rankedResults.length),
        };
        break;
      }
    }

    // Step 4: Build DecisionInput (wire ranking signals + evidence per RFC-007)
    const decisionInput = this.buildDecisionInput(plan, resolveResult, rankedResults);

    // Step 5: Build snapshot & run DecisionEngine
    const snapshot = this.buildSnapshot(plan);
    const decisionOutput = await this.deps.decisionEngine.decide(decisionInput, snapshot);

    // Step 6: Build response
    const queryTimeMs = Date.now() - startTime;
    const results = await this.mapRankedToResultItems(rankedResults);
    const counterfactuals = this.buildCounterfactuals(resolveResult, rankedResults);

    const response = this.deps.responseBuilder.build({
      queryPlan: plan,
      decisionOutput,
      results,
      counterfactuals: counterfactuals.length > 0 ? counterfactuals : undefined,
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
      conformalSetSize: computeConformalSetSize(hybridConfidence, DEFAULT_ALPHA, rankedResults.length),
    };

    return { resolveResult, rankedResults };
  }

  /**
   * Assembles DecisionInput from plan, resolver result, and optional ranking
   * results.  Wires ranking signals, evidence summary, and evidence items into
   * the decision input so the Decision Engine can use them (RFC-007 §4).
   *
   * When rankedResults are present the top candidate's component scores are
   * mapped to a SignalSet, and its pre-computed evidence items are forwarded.
   * identityEvidencePresent is true whenever there is at least one ranked
   * result or the resolver found a top entity.
   */
  private buildDecisionInput(
    plan: QueryPlanV1,
    resolverResult: EntityResolveResult,
    rankedResults?: readonly RankedResult[],
  ): DecisionInput {
    const topResult = rankedResults?.[0];

    // Build ranking signals from the top ranked candidate (RFC-007).
    const rankingSignals: SignalSet | undefined =
      topResult !== undefined
        ? {
            entity_integrity_score: topResult.componentScores.entityIntegrity,
            hard_constraint_pass: topResult.componentScores.hardConstraintPass ? 1 : 0,
            soft_constraint_score: topResult.componentScores.softConstraint,
            semantic_relevance_score: topResult.componentScores.semantic,
            preference_alignment_score: topResult.componentScores.preferenceAlignment,
            popularity_score: topResult.componentScores.popularity,
            availability_score: topResult.componentScores.availability,
            uncertainty_penalty: topResult.componentScores.uncertaintyPenalty,
          }
        : undefined;

    // Identity evidence is present when the ranking pipeline returned results
    // or when the resolver found a top entity (entity-route without ranking).
    const identityEvidencePresent =
      (rankedResults !== undefined && rankedResults.length > 0) ||
      resolverResult.topEntity !== undefined;

    // Anchor evidence is present when the plan is a mixed-query route that
    // found a resolved anchor entity (RFC-016 §5).
    const anchorEvidencePresent =
      plan.route === 'mixed' && resolverResult.topEntity !== undefined;

    const evidenceSummary: EvidenceSummary = {
      identityEvidencePresent,
      ...(topResult !== undefined
        ? {
            constraintEvidencePresent: topResult.componentScores.hardConstraintPass,
            evidenceRefCount: topResult.evidenceItems.length,
          }
        : {}),
      ...(anchorEvidencePresent ? { anchorEvidencePresent } : {}),
    };

    return {
      queryPlan: plan,
      resolverResult,
      policy: plan.policy,
      uncertainty: plan.uncertainty,
      ...(rankingSignals !== undefined ? { rankingSignals } : {}),
      evidenceSummary,
      ...(topResult !== undefined ? { evidenceItems: topResult.evidenceItems } : {}),
      ...(resolverResult.conformalSetSize !== undefined
        ? { conformalSetSize: resolverResult.conformalSetSize }
        : {}),
    };
  }

  /**
   * Builds a DecisionSnapshot from the current plan state.
   * Populates model_versions and index_versions from injected snapshotVersions
   * per RFC-015, which requires actual version strings (not empty objects).
   *
   * If snapshotVersions were not injected, or if both version maps are empty,
   * the snapshot includes a nondeterminism_notes string to signal that version
   * tracking is incomplete and reproducibility cannot be guaranteed.
   */
  private buildSnapshot(plan: QueryPlanV1): DecisionSnapshot {
    const versions = this.deps.snapshotVersions;
    const modelVersions = versions?.modelVersions ?? {};
    const indexVersions = versions?.indexVersions ?? {};

    const versionsAbsent = versions === undefined;
    const bothEmpty =
      Object.keys(modelVersions).length === 0 && Object.keys(indexVersions).length === 0;

    const hasInconsistency = versionsAbsent || bothEmpty;
    const nondeterminismNote = versionsAbsent
      ? 'snapshotVersions not injected; model_versions and index_versions are empty — snapshot reproducibility cannot be guaranteed'
      : bothEmpty
        ? 'snapshotVersions injected but both modelVersions and indexVersions are empty — snapshot reproducibility cannot be guaranteed'
        : undefined;

    return {
      model_versions: modelVersions,
      index_versions: indexVersions,
      policy_rule_version: plan.policyRuleVersion,
      threshold_profile_id: plan.thresholdProfileId,
      planner_version: plan.plannerVersion,
      feature_flags: {},
      ...(hasInconsistency && nondeterminismNote !== undefined
        ? { nondeterminism_notes: nondeterminismNote }
        : {}),
    };
  }

  /**
   * Builds counterfactual rejection records per RFC-008 §5.
   *
   * Surfaces two classes of rejected candidates:
   *   1. Resolver candidates ranked below the top entity (entity route) —
   *      shows why each alternative was not selected.
   *   2. Ranked results beyond the top-5 window (hybrid route) —
   *      shows lower-scoring candidates that were considered but not returned.
   *
   * This gives API consumers full transparency about what the engine evaluated
   * and why it was not chosen, enabling audit and debugging.
   */
  private buildCounterfactuals(
    resolverResult: EntityResolveResult,
    rankedResults: readonly RankedResult[],
    topResultWindow: number = 5,
  ): readonly CounterfactualReject[] {
    const counterfactuals: CounterfactualReject[] = [];
    const topEntityId = resolverResult.topEntity?.entityId;

    // Class 1: Resolver candidates that scored below the top entity
    if (resolverResult.candidates.length > 1) {
      for (const candidate of resolverResult.candidates) {
        if (candidate.entityId === topEntityId) continue;
        counterfactuals.push({
          entityId: candidate.entityId,
          canonicalLabel: candidate.canonicalLabel,
          rejectedReason:
            `Calibrated score ${candidate.calibratedScore.toFixed(3)} below top candidate` +
            (topEntityId !== undefined
              ? ` (rank ${candidate.rank} of ${resolverResult.candidates.length})`
              : ''),
          ...(candidate.evidenceRefs[0] !== undefined
            ? { evidenceRef: candidate.evidenceRefs[0] }
            : {}),
        });
      }
    }

    // Class 2: Ranked results beyond the top-N window
    if (rankedResults.length > topResultWindow) {
      for (const result of rankedResults.slice(topResultWindow)) {
        counterfactuals.push({
          entityId: result.entityId,
          canonicalLabel: result.canonicalLabel,
          rejectedReason:
            `Lower ranking (rank ${result.rank}/${rankedResults.length}); ` +
            `final_score=${result.finalScore.toFixed(3)}, ` +
            `hard_constraint_pass=${String(result.componentScores.hardConstraintPass)}`,
        });
      }
    }

    return counterfactuals;
  }

  /**
   * Maps ranked results to response-level ResultItems with drinking window enrichment (Epic 15).
   *
   * Drinking window is populated from:
   * 1. Cached drinkingWindowStart/End (if available from Vespa)
   * 2. Dynamic prediction via DrinkingWindowUseCase.check() (if wine attributes available)
   */
  private async mapRankedToResultItems(
    rankedResults: readonly RankedResult[],
  ): Promise<readonly ResultItem[]> {
    const currentYear = new Date().getFullYear();
    const items: ResultItem[] = [];

    for (const r of rankedResults) {
      // Determine drinking window
      let drinkingWindow: typeof undefined | {
        readonly drinkingWindowStart: number;
        readonly drinkingWindowEnd: number;
        readonly currentlyDrinkable: boolean;
        readonly confidence: 'high' | 'medium' | 'low';
        readonly modelVersion?: string | undefined;
      };

      // Option 1: Use cached values from Vespa (if available)
      if (r.drinkingWindowStart !== undefined && r.drinkingWindowEnd !== undefined) {
        drinkingWindow = {
          drinkingWindowStart: r.drinkingWindowStart,
          drinkingWindowEnd: r.drinkingWindowEnd,
          currentlyDrinkable:
            currentYear >= r.drinkingWindowStart && currentYear <= r.drinkingWindowEnd,
          confidence: 'high' as const,
        };
      }
      // Option 2: Predict dynamically from wine attributes (Epic 15)
      else if (
        this.deps.drinkingWindow !== undefined &&
        r.vintage !== undefined &&
        r.body !== undefined &&
        r.tannin !== undefined &&
        r.acidity !== undefined &&
        r.sweetness !== undefined &&
        r.grapePrimaryEnc !== undefined &&
        r.regionEnc !== undefined &&
        r.countryEnc !== undefined
      ) {
        const prediction = await this.deps.drinkingWindow.check({
          vintage: r.vintage,
          grapePrimaryEnc: r.grapePrimaryEnc,
          regionEnc: r.regionEnc,
          countryEnc: r.countryEnc,
          body: r.body,
          tannin: r.tannin,
          acidity: r.acidity,
          sweetness: r.sweetness,
          avgCriticProxyScore: r.avgCriticProxyScore ?? 0,
        });
        drinkingWindow = prediction;
      }

      const baseItem: ResultItem = {
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
      };

      // Enrich with drinking window if available (exactOptionalPropertyTypes)
      items.push(
        drinkingWindow !== undefined
          ? { ...baseItem, drinkingWindow }
          : baseItem,
      );
    }

    return items;
  }

  /**
   * Builds a SearchResponseV1 that rejects the query as a prompt injection attack.
   *
   * Returns HTTP 400 (Bad Request) with:
   * - decisionStatus: 'failed'
   * - failure_reason: 'POLICY_BLOCKED'
   * - nextAction: 'reject'
   * - No results (empty array)
   * - No evidence items
   *
   * Error message is intentionally generic to avoid pattern leakage to attackers.
   *
   * @param requestId - Caller-supplied request ID for correlation
   * @param startTime - Timestamp when query processing began
   * @param layer - Which layer blocked the query ('LAYER_1_BLOCKED' or 'LAYER_2_BLOCKED')
   * @param reason - Specific injection reason code from QuerySanitizer or LLMInjectionJudge
   * @returns SearchResponseV1 with failed status and policy rejection
   */
  private buildInjectionRejection(
    requestId: string,
    startTime: number,
    layer: 'LAYER_1_BLOCKED' | 'LAYER_2_BLOCKED',
    reason: string,
  ): SearchResponseV1 {
    const queryTimeMs = Date.now() - startTime;

    // Build a minimal decision snapshot (no version tracking for rejections)
    const snapshot = {
      model_versions: {},
      index_versions: {},
      policy_rule_version: '1',
      threshold_profile_id: 'default',
      planner_version: 'security_gate',
      feature_flags: {},
    } as const;

    // Build response with failed status and POLICY_BLOCKED reason
    return {
      queryType: 'search' as const,
      engineDecision: {
        decisionStatus: 'failed' as const,
        nextAction: 'reject' as const,
        route: 'security_gate',
        decisionConfidence: 0,
        confidenceSemantics: 'calibrated_decision_confidence' as const,
        decisionTraceRef: `injection_reject_${layer}_${Date.now()}`,
        decisionSnapshot: snapshot,
        failure_reason: 'POLICY_BLOCKED',
      },
      results: [],
      meta: {
        requestId,
        queryTimeMs,
        route: 'security_gate',
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        decisionSnapshot: snapshot,
        response_hash: 'security_rejection',
        debugRefs: [`injection_defense:${layer}:${reason}`],
      },
    };
  }
}
