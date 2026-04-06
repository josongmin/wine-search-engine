import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { PlannerContext } from '../../domain/query/service/planner.js';
import type { ResolverInput } from '../../domain/resolver/service/resolver.js';
import type { DecisionInput, EvidenceSummary } from '../../domain/decision/model/decision-input.js';
import type { DecisionOutput } from '../../domain/decision/model/decision-output.js';
import { AbstainPolicy } from '../../domain/query/service/abstain-policy.js';
import { ConstraintSAT } from '../../domain/query/service/constraint-sat.js';
import type { DecisionSnapshot, SignalSet } from '../../domain/shared/types/index.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type { RankingInput } from '../../domain/ranking/model/ranking-input.js';
import type { DrinkingWindowBlock, ResultItem } from '../../domain/response/model/result-item.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { computeConformalSetSize, DEFAULT_ALPHA } from '../../domain/resolver/service/resolver.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { QueryRoute } from '../../domain/query/model/query-route.js';
import type { EntityId } from '../../domain/shared/types/index.js';
import type { CounterfactualReject } from '../../domain/response/model/counterfactual.js';
import type { DrinkingWindowUseCasePort } from '../drinking-window/port/drinking-window-usecase.port.js';
import type { QuerySanitizer } from '../../domain/security/service/query-sanitizer.js';
import type { InjectionJudgePort } from '../../domain/security/port/injection-judge.port.js';
import type { SearchResponseCachePort } from '../../domain/performance/port/search-response-cache.port.js';
import { LTRRanker } from '../../domain/ranking/service/ltr-ranker.js';
import { extractLTRFeatures } from '../../domain/ranking/service/ltr-feature-extractor.js';
import type { QueryClassWeights } from '../../domain/ranking/index.js';
import type { ComparisonSearchResponse } from '../../domain/response/model/comparison-response.js';
import { detectDecomposition, isValidDecomposition } from '../../domain/query/service/decomposition-detector.js';
import type { QueryEntrySecurityObserver } from '../../infrastructure/observability/query-entry-security-metrics.js';
import { QueryEntrySecurityGate } from './query-entry-security.js';
import type { DecomposedSearchUseCasePort } from './port/search-route-usecases.port.js';
import type { SearchRequest } from './search-request.dto.js';
import type {
  BrowseRetrieverPort,
  CandidatePoolPort,
  CompareRetrieverPort,
  DecisionEnginePort,
  EntityResolverPort,
  MixedSolverPort,
  QueryPlannerPort,
  RankingPort,
  ResponseBuilderPort,
} from './port/search-pipeline-deps.port.js';

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
  private static readonly SPECIALIZED_RETRIEVAL_LIMIT = 20;
  private readonly abstainPolicy = new AbstainPolicy();
  private readonly constraintSAT = new ConstraintSAT();

  constructor(private readonly deps: SearchUseCaseDeps) {}

  // DISABLED: Caching infrastructure is incomplete; skip for now (Wave 4 backlog)
  // private buildQueryCacheKey(plan: QueryPlanV1, request: SearchRequest): QueryCacheKey {
  //   const cacheKeyBuilder = new QueryCacheKeyBuilder();
  //   const expansionTerms = [...plan.expansions.lexical, ...plan.expansions.semantic];
  //   const constraintTuples = plan.constraints.hard.map((c) => {
  //     const v = c.value;
  //     const valueStr =
  //       typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  //         ? String(v)
  //         : JSON.stringify(v);
  //     return [c.attribute, c.operator, valueStr] as const;
  //   });
  //   return cacheKeyBuilder.build(
  //     plan.normalizedQuery,
  //     plan.retrievalMode,
  //     constraintTuples,
  //     expansionTerms,
  //     request.sessionContext?.sessionId,
  //     request.context?.locale,
  //   );
  // }

  async execute(
    request: SearchRequest,
    requestId: string,
  ): Promise<SearchResponseV1 | ComparisonSearchResponse> {
    const startTime = Date.now();
    const securityGate = new QueryEntrySecurityGate({
      querySanitizer: this.deps.querySanitizer,
      injectionJudge: this.deps.injectionJudge,
      judgeFailureMode: this.deps.judgeFailureMode,
      observer: this.deps.queryEntrySecurityObserver,
    });
    const sanitizedQuery = await securityGate.getSafeQueryOrThrow(request.query);

    // Epic 14: Detect "A vs B" decomposable comparison queries
    if (this.deps.decomposedSearch) {
      const decomposed = detectDecomposition(sanitizedQuery);
      if (isValidDecomposition(decomposed)) {
        return this.deps.decomposedSearch.execute(
          decomposed.subQueries,
          decomposed.comparisonIntent,
          sanitizedQuery,
          requestId,
          startTime,
        );
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

    // Step 1a: Constraint contradiction check (Epic 13, RFC-006 §4.2)
    // Detect logically impossible constraint combinations before any retrieval.
    const satResult = this.constraintSAT.check(plan.constraints);
    if (satResult.contradicted) {
      const conflictDesc = satResult.conflictPairs
        .map(([a, b]) => `${a.attribute}: ${JSON.stringify(a.value)} vs ${JSON.stringify(b.value)}`)
        .join('; ');
      const snapshot = this.buildSnapshot(plan);
      const apiOverrideMode = request.retrieval_mode !== undefined && request.retrieval_mode !== 'auto'
        ? request.retrieval_mode
        : undefined;
      const effectiveRoute = apiOverrideMode ?? this.resolveRoute(plan, request.options?.mode);
      const retrievalModeSource: 'planner' | 'api_override' = apiOverrideMode !== undefined
        ? 'api_override'
        : 'planner';

      return this.deps.responseBuilder.build({
        queryPlan: plan,
        decisionOutput: {
          decisionStatus: 'failed',
          nextAction: 'fail',
          decisionConfidence: 0,
          confidenceSemantics: 'calibrated_decision_confidence',
          signalSet: {
            entity_integrity_score: 0,
            hard_constraint_pass: 0,
            soft_constraint_score: 0,
            semantic_relevance_score: 0,
            preference_alignment_score: 0,
            popularity_score: 0,
            availability_score: 0,
            uncertainty_penalty: 0,
          },
          evidenceItems: [],
          decisionTraceRef: `constraint-sat:${requestId}`,
          decisionSnapshot: snapshot,
          failureReason: 'HARD_CONSTRAINT_VIOLATION',
          decisionTrace: {
            decisionStatus: 'failed',
            nextAction: 'fail',
            inputs: {
              queryClass: plan.queryClass,
              policy: plan.policy as unknown as Readonly<Record<string, unknown>>,
            },
            signals: {
              decisionConfidence: 0,
              calibratedGap: 0,
              ambiguity: false,
            },
            thresholds: {
              resolveThreshold: 0,
              gapThreshold: 0,
            },
            versions: {
              plannerVersion: plan.plannerVersion,
              policyRuleVersion: plan.policyRuleVersion,
              thresholdProfileId: plan.thresholdProfileId,
            },
            rulesApplied: ['CONSTRAINT_SAT'],
            finalReason: `Contradictory constraints: ${conflictDesc}`,
          },
          candidates: [],
        },
        results: [],
        requestId,
        queryTimeMs: Date.now() - startTime,
        route: effectiveRoute,
        retrievalModeSource,
        plannerSuggestedMode: plan.route,
      });
    }

    // Step 1b: Query cache check (Wave 4, Phase 3)
    // Cache hit avoids resolution, retrieval, ranking, decision engine
    // RFC-015: Validates snapshot version freshness
    if (this.deps.cacheService) {
      // Normalize sessionContext: omit previousEntities to match CacheService interface
      const cacheSessionContext = request.sessionContext
        ? { sessionId: request.sessionContext.sessionId }
        : undefined;

      const cacheResult = await this.deps.cacheService.getSearchResponse(
        plan,
        {
          ...(cacheSessionContext !== undefined ? { sessionContext: cacheSessionContext } : {}),
          ...(request.context !== undefined ? { context: { locale: request.context.locale } } : {}),
        },
        this.buildSnapshot(plan), // Current snapshot for version checking
      );

      if (cacheResult.hit && cacheResult.data) {
        // Cache hit: update requestId and latency only
        return {
          ...cacheResult.data,
          meta: {
            ...cacheResult.data.meta,
            requestId,
            queryTimeMs: Date.now() - startTime,
          },
        };
      }
    }

    // Step 2: Determine effective route (top-level retrieval_mode takes precedence)
    const apiOverrideMode = request.retrieval_mode !== undefined && request.retrieval_mode !== 'auto'
      ? request.retrieval_mode
      : undefined;
    const effectiveRoute = apiOverrideMode ?? this.resolveRoute(plan, request.options?.mode);
    const plannerSuggestedMode = plan.route;
    const retrievalModeSource: 'planner' | 'api_override' = apiOverrideMode !== undefined
      ? 'api_override'
      : 'planner';

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

    // Step 3b: Entropy-based abstain check (RFC-013 S3)
    // When normalized Shannon entropy over top-K scores is too high, the query
    // is ambiguous and we request clarification instead of returning noisy results.
    const topScores = rankedResults.slice(0, 10).map((r) => r.finalScore);
    const abstainDecision = this.abstainPolicy.shouldAbstain(topScores);

    if (abstainDecision.abstain) {
      const queryTimeMs = Date.now() - startTime;
      const snapshot = this.buildSnapshot(plan);
      const syntheticDecisionOutput: DecisionOutput = {
        decisionStatus: 'ambiguous',
        nextAction: 'clarify',
        decisionConfidence: 0,
        confidenceSemantics: 'calibrated_decision_confidence',
        signalSet: {
          entity_integrity_score: 0,
          hard_constraint_pass: 0,
          soft_constraint_score: 0,
          semantic_relevance_score: 0,
          preference_alignment_score: 0,
          popularity_score: 0,
          availability_score: 0,
          uncertainty_penalty: 0,
        },
        evidenceItems: [],
        decisionTraceRef: `entropy-abstain:${requestId}`,
        decisionSnapshot: snapshot,
        decisionTrace: {
          decisionStatus: 'ambiguous',
          nextAction: 'clarify',
          inputs: {
            queryClass: plan.queryClass,
            policy: plan.policy as unknown as Readonly<Record<string, unknown>>,
          },
          signals: {
            decisionConfidence: 0,
            calibratedGap: 0,
            ambiguity: true,
          },
          thresholds: {
            resolveThreshold: 0,
            gapThreshold: 0,
          },
          versions: {
            policyRuleVersion: plan.policyRuleVersion,
            thresholdProfileId: plan.thresholdProfileId,
            plannerVersion: plan.plannerVersion,
          },
          rulesApplied: ['ENTROPY_ABSTAIN'],
          finalReason: `Normalized entropy ${abstainDecision.entropy.toFixed(4)} exceeds threshold; query is ambiguous`,
        },
      };

      const results = await this.mapRankedToResultItems(rankedResults);
      return this.deps.responseBuilder.build({
        queryPlan: plan,
        decisionOutput: syntheticDecisionOutput,
        results,
        clarification: {
          reason: `Query is ambiguous (entropy=${abstainDecision.entropy.toFixed(3)}). Please refine your search.`,
          candidates: rankedResults.slice(0, 3).map((r) => ({
            entityId: r.entityId,
            label: r.canonicalLabel,
            distinguishingFeatures: [],
          })),
          suggestionType: 'disambiguation',
        },
        requestId,
        queryTimeMs,
        route: effectiveRoute,
        retrievalModeSource,
        plannerSuggestedMode,
      });
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
      retrievalModeSource,
      plannerSuggestedMode,
    });

    // Step 7: Cache response (Wave 4, Phase 3)
    // Cache is populated after successful response building for eligible modes
    if (this.deps.cacheService) {
      // Normalize sessionContext: omit previousEntities to match CacheService interface
      const cacheSessionContext = request.sessionContext
        ? { sessionId: request.sessionContext.sessionId }
        : undefined;

      const cached = await this.deps.cacheService.setSearchResponse(
        plan,
        {
          ...(cacheSessionContext !== undefined ? { sessionContext: cacheSessionContext } : {}),
          ...(request.context !== undefined ? { context: { locale: request.context.locale } } : {}),
        },
        response,
      );
      if (!cached) {
        // Log cache miss (circuit breaker, ineligible, etc.)
        // This is non-fatal; response still returned
      }
    }

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
      if (
        plan.retrievalMode === 'producer_browse' ||
        plan.retrievalMode === 'region_browse' ||
        plan.retrievalMode === 'compare_candidates' ||
        plan.retrievalMode === 'recommendation'
      ) {
        return 'hybrid';
      }
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
      ...(plan.normalizedQueryViews !== undefined
        ? { normalizedQueryViews: plan.normalizedQueryViews }
        : {}),
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
    const candidates = await this.retrieveHybridCandidates(plan);

    // Rank the candidates
    const rankingInput: RankingInput = {
      queryPlan: plan,
      candidates,
      constraints: plan.constraints,
    };

    let rankedResults = await this.deps.ranker.rank(rankingInput);

    // Epic 4: Apply LTR reranking if model available for this query class
    const queryClass = plan.queryClass;
    const ltrModel = this.deps.ltrModels?.get(queryClass);
    if (ltrModel && rankedResults.length > 0) {
      // Convert ranked results to rankable documents for LTR
      const rankableDocuments = rankedResults.map((doc, idx) => ({
        entityId: doc.entityId,
        retrievalScore: doc.finalScore,
        features: extractLTRFeatures({
          semantic: doc.componentScores.semantic,
          popularity: doc.componentScores.popularity,
          attributeAlignment: doc.componentScores.attributeAlignment,
          preferenceAlignment: doc.componentScores.preferenceAlignment,
        }),
        originalRank: idx + 1,
      }));

      const rerankedDocs = LTRRanker.rerank(rankableDocuments, queryClass, ltrModel);

      // Map back to RankedResult preserving reranked order (already sorted
      // by ltrScore desc, then retrievalScore desc inside LTRRanker.rerank)
      const origMap = new Map(rankedResults.map((r) => [r.entityId as string, r]));
      rankedResults = rerankedDocs
        .map((reranked) => {
          const orig = origMap.get(reranked.entityId);
          if (!orig) return undefined;
          return { ...orig, finalScore: reranked.ltrScore, rank: reranked.finalRank };
        })
        .filter((r): r is RankedResult => r !== undefined);
    }

    // Build a synthetic resolve result for the hybrid path.
    // Use the top-ranked result's finalScore as the raw decision confidence,
    // clamped to [0, 1]. Hardcoding 0.5 is wrong: it always falls below
    // resolveTau (≥0.60) for most query classes, causing every hybrid search
    // to return ambiguous regardless of ranking quality.
    const top1Score = rankedResults[0]?.finalScore ?? 0;
    const top2Score = rankedResults[1]?.finalScore ?? 0;
    const hybridConfidence = Math.max(0, Math.min(1, top1Score));
    const hybridGap = Math.max(0, Math.min(1, top1Score - top2Score));

    // RFC-016: Build topEntity from top-ranked result for AdmissionGate (identity sealing)
    const topResult = rankedResults[0];
    const topEntity = topResult
      ? {
          entityId: topResult.entityId,
          canonicalLabel: topResult.canonicalLabel,
          calibratedScore: Math.max(0, Math.min(1, topResult.finalScore)),
        }
      : undefined;

    const resolveResult: EntityResolveResult = {
      status: rankedResults.length > 0 ? 'resolved' : 'failed',
      ...(topEntity !== undefined ? { topEntity } : {}),
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

  private async retrieveHybridCandidates(
    plan: QueryPlanV1,
  ): Promise<readonly HybridCandidate[]> {
    switch (plan.retrievalMode) {
      case 'producer_browse': {
        const producerName = this.extractProducerBrowseSeed(plan);
        if (producerName !== undefined && this.deps.browseRetriever !== undefined) {
          const candidates = await this.deps.browseRetriever.browseProducer(
            producerName,
            plan.constraints,
            SearchUseCase.SPECIALIZED_RETRIEVAL_LIMIT,
          );
          if (candidates.length > 0) {
            return candidates;
          }
        }
        break;
      }
      case 'region_browse': {
        const regionName = this.extractRegionBrowseSeed(plan);
        if (regionName !== undefined && this.deps.browseRetriever !== undefined) {
          const candidates = await this.deps.browseRetriever.browseRegion(
            regionName,
            plan.constraints,
            SearchUseCase.SPECIALIZED_RETRIEVAL_LIMIT,
          );
          if (candidates.length > 0) {
            return candidates;
          }
        }
        break;
      }
      case 'compare_candidates': {
        if (this.deps.compareRetriever !== undefined) {
          const anchorResolution = await this.executeEntityRoute(plan);
          const anchorEntityId = anchorResolution.topEntity?.entityId
            ?? plan.anchors[0]?.candidateEntityIds[0];
          if (anchorEntityId !== undefined) {
            const candidates = await this.deps.compareRetriever.compareAgainstAnchor(
              anchorEntityId,
              plan.constraints,
              SearchUseCase.SPECIALIZED_RETRIEVAL_LIMIT,
            );
            if (candidates.length > 0) {
              return candidates;
            }
          }
        }
        break;
      }
      default:
        break;
    }

    const retrievalInput: HybridRetrievalInput = {
      queryPlan: plan,
      route: 'hybrid',
      lexicalQueries: [plan.normalizedQuery],
      semanticQueries: [plan.rawQuery],
      hardConstraints: plan.constraints.hard,
      softConstraints: plan.constraints.soft,
    };

    return this.deps.candidatePool.generate(retrievalInput);
  }

  private extractProducerBrowseSeed(plan: QueryPlanV1): string | undefined {
    const strongestAnchor = [...plan.anchors].sort((left, right) => right.confidence - left.confidence)[0];
    const candidate = strongestAnchor?.surfaceForm.trim() ?? strongestAnchor?.normalizedForm.trim();
    return candidate !== undefined && candidate.length > 0 ? candidate : undefined;
  }

  private extractRegionBrowseSeed(plan: QueryPlanV1): string | undefined {
    const regionConstraint = [...plan.constraints.hard, ...plan.constraints.soft, ...plan.constraints.inferred].find(
      (constraint) =>
        constraint.attribute === 'region' ||
        constraint.attribute === 'appellation' ||
        constraint.attribute === 'country',
    );

    if (regionConstraint !== undefined) {
      if (typeof regionConstraint.value === 'string' && regionConstraint.value.trim().length > 0) {
        return regionConstraint.value.trim();
      }
      if (Array.isArray(regionConstraint.value) && regionConstraint.value[0] !== undefined) {
        const [firstValue] = regionConstraint.value as readonly unknown[];
        return typeof firstValue === 'string' ? firstValue : undefined;
      }
    }

    const compact = plan.normalizedQuery
      .replace(/\b(?:wine|wines|show|browse|from|region|appellation)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return compact.length > 0 ? compact : undefined;
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
      conformalSetSize: resolverResult.conformalSetSize,
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

    // Type guard: check wine attributes for prediction
    const needsPrediction = (r: RankedResult): boolean =>
      r.drinkingWindowStart === undefined && // Not cached
      r.vintage !== undefined &&
      r.body !== undefined &&
      r.tannin !== undefined &&
      r.acidity !== undefined &&
      r.sweetness !== undefined &&
      r.grapePrimaryEnc !== undefined &&
      r.regionEnc !== undefined &&
      r.countryEnc !== undefined;

    // Filter & collect results needing prediction
    const resultsPendingPrediction = rankedResults.filter(
      (r) => this.deps.drinkingWindow !== undefined && needsPrediction(r),
    );

    // 🔥 PARALLEL: Promise.all() for all predictions (not sequential loop)
    const predictions = await Promise.allSettled(
      resultsPendingPrediction.map((r) =>
        this.deps.drinkingWindow!.check({
          vintage: r.vintage!,
          grapePrimaryEnc: r.grapePrimaryEnc!,
          regionEnc: r.regionEnc!,
          countryEnc: r.countryEnc!,
          body: r.body!,
          tannin: r.tannin!,
          acidity: r.acidity!,
          sweetness: r.sweetness!,
          avgCriticProxyScore: r.avgCriticProxyScore ?? 80,
        }),
      ),
    );

    // Map results back for O(1) lookup
    const predictionMap = new Map<string, DrinkingWindowBlock>();
    resultsPendingPrediction.forEach((r, idx) => {
      const settled = predictions[idx];
      if (settled?.status === 'fulfilled') {
        predictionMap.set(r.entityId, settled.value);
      }
    });

    // Build items with drinking windows (single pass)
    return rankedResults.map((r) => {
      let drinkingWindow: DrinkingWindowBlock | undefined;

      // Priority 1: Cached from Vespa
      if (r.drinkingWindowStart !== undefined && r.drinkingWindowEnd !== undefined) {
        drinkingWindow = {
          drinkingWindowStart: r.drinkingWindowStart,
          drinkingWindowEnd: r.drinkingWindowEnd,
          currentlyDrinkable:
            currentYear >= r.drinkingWindowStart && currentYear <= r.drinkingWindowEnd,
          confidence: 'high' as const,
        };
      }
      // Priority 2: Dynamically predicted (from Promise.all())
      else {
        const predicted = predictionMap.get(r.entityId);
        if (predicted) {
          drinkingWindow = predicted;
        }
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
      };

      return drinkingWindow !== undefined
        ? { ...baseItem, drinkingWindow }
        : baseItem;
    });
  }
}
