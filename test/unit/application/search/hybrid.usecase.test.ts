import { describe, expect, it, vi } from 'vitest';
import { HybridUseCase } from '../../../../src/application/search/hybrid.usecase.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

function createPlan(
  overrides: Partial<QueryPlanV1> = {},
): QueryPlanV1 {
  return {
    rawQuery: 'ridge cabernet',
    normalizedQuery: 'ridge cabernet',
    intent: 'search',
    route: 'hybrid',
    retrievalMode: 'semantic_hybrid',
    queryClass: 'known_item',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {
      requireExact: false,
      allowApproximate: true,
      requireClarification: false,
      fallbackMode: 'none',
      policyReasonCodes: [],
    },
    uncertainty: {
      ambiguityScore: 0,
      missingInformation: [],
      approximationUsed: false,
      approximationKind: null,
    },
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
    rawConstraints: [],
    parsedConstraints: { recognized: [], unparsed: [] },
    ...overrides,
  } as QueryPlanV1;
}

function createDecisionOutput() {
  return {
    decisionStatus: 'resolved' as const,
    nextAction: 'respond' as const,
    route: 'hybrid',
    decisionConfidence: 0.91,
    confidenceSemantics: 'calibrated_decision_confidence' as const,
    decisionTraceRef: 'trace-1',
    decisionSnapshot: {
      model_versions: {},
      index_versions: {},
      policy_rule_version: '1.0.0',
      threshold_profile_id: 'default',
      planner_version: '1.0.0',
      feature_flags: {},
    },
  };
}

function createCachedSearchResponse(requestId = 'cached-request') {
  const decisionOutput = createDecisionOutput();
  return {
    queryType: 'search' as const,
    engineDecision: {
      decisionStatus: decisionOutput.decisionStatus,
      nextAction: decisionOutput.nextAction,
      route: decisionOutput.route,
      decisionConfidence: decisionOutput.decisionConfidence,
      confidenceSemantics: decisionOutput.confidenceSemantics,
      decisionTraceRef: 'trace-cached',
      decisionSnapshot: decisionOutput.decisionSnapshot,
    },
    results: [],
    meta: {
      requestId,
      queryTimeMs: 12,
      route: decisionOutput.route,
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot: decisionOutput.decisionSnapshot,
      response_hash: 'cached-hash',
    },
  };
}

function createResponseBuilder() {
  return {
    build: vi.fn((params: any) => ({
      queryType: 'search' as const,
      engineDecision: {
        decisionStatus: params.decisionOutput.decisionStatus,
        nextAction: params.decisionOutput.nextAction,
        route: params.route,
        decisionConfidence: params.decisionOutput.decisionConfidence,
        confidenceSemantics: params.decisionOutput.confidenceSemantics,
        decisionTraceRef: params.decisionOutput.decisionTraceRef,
        decisionSnapshot: params.decisionOutput.decisionSnapshot,
      },
      results: params.results,
      meta: {
        requestId: params.requestId,
        queryTimeMs: params.queryTimeMs,
        route: params.route,
        version: '1.0.0',
        engine_schema_version: 'search_response_v1',
        decisionSnapshot: params.decisionOutput.decisionSnapshot,
        response_hash: 'hash',
      },
    })),
  };
}

const safeSanitizer = {
  sanitize: (query: string) => ({
    safe: true,
    sanitizedQuery: query.trim(),
  }),
};

function createAnchorDocument(entityId: string) {
  return {
    entityId,
    entityType: 'wine',
    canonicalLabel: 'Opus One 2021',
    aliasesIdentitySafe: ['opus one'],
    aliasesNoisyRecall: ['opus'],
    producer: 'Opus One Winery',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '오퍼스 원 나파 밸리',
    searchTextEn: 'Opus One Napa Valley',
    semanticSummary: 'A benchmark Napa Valley Cabernet blend.',
    body: 5,
    sweetness: 1,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['steak'],
    occasion: ['cellaring'],
    availability: true,
    popularityScore: 0.92,
  };
}

function createResolvedResolverResult(plan: QueryPlanV1, entityId: string) {
  return {
    status: 'resolved' as const,
    topEntity: {
      entityId,
      canonicalLabel: 'Opus One 2021',
      calibratedScore: 0.96,
    },
    candidates: [{
      entityId,
      canonicalLabel: 'Opus One 2021',
      calibratedScore: 0.96,
      rank: 1,
      evidenceRefs: ['alias'],
    }],
    decisionTrace: {
      queryClass: plan.queryClass,
      top1CalibratedScore: 0.96,
      top2CalibratedScore: 0.2,
      calibratedGap: 0.76,
      decisionConfidenceC: 0.96,
      ambiguityDetected: false,
      ambiguityTypes: [],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: ['TEST'],
    },
    conformalSetSize: 1,
  };
}

function createRankedResult(
  entityId: string,
  canonicalLabel: string,
  finalScore: number,
  rank: number,
  evidenceItems: Array<{
    type: string;
    source: string;
    contribution: string;
    strength: 'low' | 'medium' | 'high';
    provenance: string;
  }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    entityId,
    canonicalLabel,
    finalScore,
    rank,
    componentScores: {
      entityIntegrity: 1,
      semantic: 0.7,
      hardConstraintPass: true,
      softConstraint: 0.1,
      attributeAlignment: 0.2,
      preferenceAlignment: 0.1,
      popularity: 0.3,
      availability: 1,
      uncertaintyPenalty: 0.02,
    },
    sparseRank: rank,
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceItems,
    ...overrides,
  };
}

function createComparePlan(anchorEntityId: string) {
  return createPlan({
    retrievalMode: 'compare_candidates',
    anchors: [{
      surfaceForm: 'Opus One',
      normalizedForm: 'opus one',
      confidence: 0.98,
      candidateEntityIds: [anchorEntityId],
    }] as QueryPlanV1['anchors'],
  });
}

function createCompareRetrieverResult(entityId: string) {
  return [{
    entityId,
    canonicalLabel: 'Dominus 2021',
    retrievalFusionScore: 0.84,
    sparseRawScore: 0.84,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'compare_default',
      lexicalQueriesUsed: ['opus one'],
      semanticQueriesUsed: ['opus one'],
      filtersApplied: [],
      candidateSources: ['sparse_bm25', 'compare_anchor'],
    },
  }];
}

function createKnownItemLtrModel() {
  return {
    queryClass: 'known_item' as const,
    weights: [0, 0, 1, 0, 0, 0, 0, 0],
    bias: 0,
    trainingExampleCount: 1,
    ndcg5ValidationScore: 1,
    trainedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function makeHybridUseCase(overrides: Record<string, unknown> = {}) {
  return new HybridUseCase({
    queryPlanner: { plan: vi.fn().mockResolvedValue(createPlan()) } as never,
    candidatePool: { generate: vi.fn().mockResolvedValue([]) } as never,
    ranker: { rank: vi.fn().mockResolvedValue({ results: [], metadata: { coarsePruneSummary: undefined, rerankExecuted: false, rerankGateReason: undefined, runtimeSignal: undefined, preRerankTop5: [] } }) } as never,
    decisionEngine: { decide: vi.fn().mockResolvedValue(createDecisionOutput()) } as never,
    responseBuilder: createResponseBuilder() as never,
    querySanitizer: safeSanitizer as never,
    ...overrides,
  });
}

describe('HybridUseCase', () => {
  it('throws AbortError when abortSignal is already aborted before execute', async () => {
    const queryPlanner = { plan: vi.fn().mockResolvedValue(createPlan()) };
    const useCase = makeHybridUseCase({ queryPlanner: queryPlanner as never });
    const ac = new AbortController();
    ac.abort();

    await expect(
      useCase.execute({ query: 'ridge cabernet' }, 'req-abort-early', { abortSignal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(queryPlanner.plan).not.toHaveBeenCalled();
  });

  it('forwards abortSignal into planner context when provided', async () => {
    const plan = createPlan();
    const queryPlanner = { plan: vi.fn().mockResolvedValue(plan) };
    const useCase = makeHybridUseCase({ queryPlanner: queryPlanner as never });
    const ac = new AbortController();

    await useCase.execute({ query: 'ridge cabernet' }, 'req-abort-fwd', { abortSignal: ac.signal });

    expect(queryPlanner.plan).toHaveBeenCalledWith(
      'ridge cabernet',
      expect.objectContaining({ abortSignal: ac.signal }),
    );
  });

  it('throws DomainError when the hybrid ranking pipeline crashes (propagated as 500)', async () => {
    const plan = createPlan();
    const useCase = makeHybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      candidatePool: {
        generate: vi.fn().mockRejectedValue(new Error('rank pipeline exploded')),
      } as never,
    });

    // The refactored hybrid use case now throws instead of returning a
    // degraded 200 response — this surfaces pipeline crashes as 500 to the
    // HTTP error handler, making them visible to monitoring + SLOs.
    await expect(
      useCase.execute({ query: 'ridge cabernet' }, 'req-hybrid-error'),
    ).rejects.toThrow('Hybrid pipeline failed unexpectedly');
  });

  it('reuses the shared planner context mapping for locale, session, and budget', async () => {
    const previousEntity = createEntityId();
    const plan = createPlan();
    const queryPlanner = { plan: vi.fn().mockResolvedValue(plan) };
    const useCase = makeHybridUseCase({ queryPlanner: queryPlanner as never });

    await useCase.execute(
      {
        query: '  ridge cabernet  ',
        context: { locale: 'ko-KR', currency: 'KRW' },
        sessionContext: {
          sessionId: 'session-1',
          previousEntities: [previousEntity],
        },
        queryBudget: {
          maxLatencyMs: 1200,
          maxCandidates: 48,
          rerankLimit: 16,
        },
      },
      'req-context',
    );

    expect(queryPlanner.plan).toHaveBeenCalledWith('ridge cabernet', {
      locale: 'ko-KR',
      session: {
        sessionId: 'session-1',
        previousEntities: [previousEntity],
      },
      budget: {
        maxLatencyMs: 1200,
        maxCandidates: 48,
        rerankLimit: 16,
      },
    });
  });

  it('preserves specialized producer browse retrieval in the shared hybrid route pipeline', async () => {
    const plan = createPlan({
      retrievalMode: 'producer_browse',
      anchors: [{
        surfaceForm: 'Ridge Vineyards',
        normalizedForm: 'ridge vineyards',
        confidence: 0.97,
        candidateEntityIds: [],
      }] as QueryPlanV1['anchors'],
    });
    const browseRetriever = {
      browseProducer: vi.fn().mockResolvedValue([{
        entityId: createEntityId(),
        canonicalLabel: 'Ridge Monte Bello 2021',
        retrievalFusionScore: 0.88,
        sparseRawScore: 0.88,
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'producer_browse',
          lexicalQueriesUsed: ['ridge vineyards'],
          semanticQueriesUsed: ['ridge vineyards'],
          filtersApplied: [],
          candidateSources: ['sparse_bm25', 'browse_producer'],
        },
      }]),
      browseRegion: vi.fn(),
    };
    const candidatePool = { generate: vi.fn() };
    const ranker = { rank: vi.fn().mockResolvedValue({ results: [], metadata: { coarsePruneSummary: undefined, rerankExecuted: false, rerankGateReason: undefined, runtimeSignal: undefined, preRerankTop5: [] } }) };
    const decisionEngine = { decide: vi.fn().mockResolvedValue(createDecisionOutput()) };
    const responseBuilder = createResponseBuilder();
    const useCase = makeHybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      candidatePool: candidatePool as never,
      browseRetriever: browseRetriever as never,
      ranker: ranker as never,
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
    });

    await useCase.execute({ query: 'Ridge Vineyards' }, 'req-browse');

    expect(browseRetriever.browseProducer).toHaveBeenCalledWith(
      'Ridge Vineyards',
      plan.constraints,
      20,
    );
    expect(candidatePool.generate).not.toHaveBeenCalled();
  });

  it('returns cached search responses before retrieval/ranking work', async () => {
    const plan = createPlan();
    const cachedResponse = createCachedSearchResponse();
    const candidatePool = { generate: vi.fn() };
    const ranker = { rank: vi.fn() };
    const decisionEngine = { decide: vi.fn() };
    const responseBuilder = createResponseBuilder();
    const cacheService = {
      getSearchResponse: vi.fn().mockResolvedValue({
        hit: true,
        data: cachedResponse,
      }),
      setSearchResponse: vi.fn(),
    };
    const useCase = makeHybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      candidatePool: candidatePool as never,
      ranker: ranker as never,
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      cacheService: cacheService as never,
    });

    const response = await useCase.execute({ query: 'ridge cabernet' }, 'req-cached');

    expect(cacheService.getSearchResponse).toHaveBeenCalledOnce();
    expect(candidatePool.generate).not.toHaveBeenCalled();
    expect(ranker.rank).not.toHaveBeenCalled();
    expect(decisionEngine.decide).not.toHaveBeenCalled();
    expect(responseBuilder.build).not.toHaveBeenCalled();
    expect(response.meta.requestId).toBe('req-cached');
  });

  it('reuses shared decomposition for compare-style hybrid queries before planning', async () => {
    const decomposedSearch = {
      execute: vi.fn().mockResolvedValue({
        queryType: 'comparison',
        originalQuery: 'Opus One vs Screaming Eagle',
        comparisonIntent: 'compare',
        entities: [
          {
            subQuery: 'Opus One',
            topResult: null,
            resultCount: 0,
            resolutionStatus: 'failed',
            allResults: [],
          },
          {
            subQuery: 'Screaming Eagle',
            topResult: null,
            resultCount: 0,
            resolutionStatus: 'failed',
            allResults: [],
          },
        ],
        overallStatus: 'failed',
        requestId: 'req-hybrid-compare',
        executionTimeMs: 3,
      }),
    };
    const queryPlanner = { plan: vi.fn() };
    const useCase = makeHybridUseCase({
      queryPlanner: queryPlanner as never,
      candidatePool: { generate: vi.fn() } as never,
      ranker: { rank: vi.fn() } as never,
      decisionEngine: { decide: vi.fn() } as never,
      responseBuilder: createResponseBuilder() as never,
      decomposedSearch: decomposedSearch as never,
    });

    const response = await useCase.execute(
      {
        query: 'Opus One vs Screaming Eagle',
        context: { locale: 'en-US', currency: 'USD' },
        sessionContext: { sessionId: 'session-2', previousEntities: [createEntityId('prev')] },
        queryBudget: { maxLatencyMs: 700, maxCandidates: 10, rerankLimit: 5 },
      },
      'req-hybrid-compare',
    );

    expect(response).toMatchObject({
      queryType: 'comparison',
      comparisonIntent: 'compare',
      originalQuery: 'Opus One vs Screaming Eagle',
    });
    expect(decomposedSearch.execute).toHaveBeenCalledWith(
      ['Opus One', 'Screaming Eagle'],
      'compare',
      'Opus One vs Screaming Eagle',
      'req-hybrid-compare',
      expect.any(Number),
      {
        context: { locale: 'en-US', currency: 'USD' },
        sessionContext: { sessionId: 'session-2', previousEntities: [expect.any(String)] },
        queryBudget: { maxLatencyMs: 700, maxCandidates: 10, rerankLimit: 5 },
      },
      { abortSignal: expect.any(AbortSignal) },
    );
    expect(queryPlanner.plan).not.toHaveBeenCalled();
  });

  it('uses the shared entity-route fallback before specialized compare retrieval', async () => {
    const anchorEntityId = createEntityId('anchor');
    const comparedEntityId = createEntityId('peer');
    const plan = createComparePlan(anchorEntityId);
    const compareRetriever = {
      compareAgainstAnchor: vi.fn().mockResolvedValue(createCompareRetrieverResult(comparedEntityId)),
    };
    const entityLookup = {
      getDocument: vi.fn().mockResolvedValue(createAnchorDocument(anchorEntityId)),
    };
    const entityResolver = {
      resolve: vi.fn().mockResolvedValue(createResolvedResolverResult(plan, anchorEntityId)),
    };
    const candidatePool = { generate: vi.fn() };
    const useCase = makeHybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      candidatePool: candidatePool as never,
      compareRetriever: compareRetriever as never,
      entityResolver: entityResolver as never,
      entityLookup: entityLookup as never,
    });

    await useCase.execute({ query: 'Opus One alternatives' }, 'req-compare');

    expect(entityResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      queryClass: plan.queryClass,
      candidateEntities: [
        expect.objectContaining({
          entityId: anchorEntityId,
          canonicalLabel: 'Opus One 2021',
        }),
      ],
    }));
    expect(compareRetriever.compareAgainstAnchor).toHaveBeenCalledWith(
      anchorEntityId,
      plan.constraints,
      20,
    );
    expect(candidatePool.generate).not.toHaveBeenCalled();
  });

  it('preserves anchorEntityId when compare retrieval falls back to candidate pool generation', async () => {
    const anchorEntityId = createEntityId('anchor');
    const plan = createComparePlan(anchorEntityId);
    const compareRetriever = {
      compareAgainstAnchor: vi.fn().mockResolvedValue([]),
    };
    const entityLookup = {
      getDocument: vi.fn().mockResolvedValue(createAnchorDocument(anchorEntityId)),
    };
    const entityResolver = {
      resolve: vi.fn().mockResolvedValue(createResolvedResolverResult(plan, anchorEntityId)),
    };
    const candidatePool = {
      generate: vi.fn().mockResolvedValue([]),
    };
    const responseBuilder = createResponseBuilder();
    const useCase = makeHybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      candidatePool: candidatePool as never,
      compareRetriever: compareRetriever as never,
      entityResolver: entityResolver as never,
      entityLookup: entityLookup as never,
      responseBuilder: responseBuilder as never,
    });

    await useCase.execute({ query: 'Opus One alternatives' }, 'req-compare-fallback');

    expect(compareRetriever.compareAgainstAnchor).toHaveBeenCalledWith(
      anchorEntityId,
      plan.constraints,
      20,
    );
    expect(candidatePool.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        queryPlan: plan,
        anchorEntityId,
      }),
    );
    const responseParams = responseBuilder.build.mock.calls[0]?.[0];
    expect(responseParams?.contract).toEqual({
      executionMode: 'degraded',
      degradationReasons: ['compare_candidates_fallback'],
    });
  });

  it('applies shared LTR reranking before synthetic resolve and decision assembly', async () => {
    const firstEntityId = createEntityId();
    const secondEntityId = createEntityId();
    const plan = createPlan();
    const ranker = {
      rank: vi.fn().mockResolvedValue({
        results: [
          createRankedResult(
            firstEntityId,
            'Alpha',
            0.82,
            1,
            [{
              type: 'alpha',
              source: 'ranker',
              contribution: '+0.10',
              strength: 'medium' as const,
              provenance: 'alpha evidence',
            }],
            {
              componentScores: {
                entityIntegrity: 1,
                semantic: 0.9,
                hardConstraintPass: true,
                softConstraint: 0.2,
                attributeAlignment: 0.1,
                preferenceAlignment: 0.1,
                popularity: 0.1,
                availability: 1,
                uncertaintyPenalty: 0.05,
              },
            },
          ),
          createRankedResult(
            secondEntityId,
            'Beta',
            0.79,
            2,
            [{
              type: 'beta',
              source: 'ranker',
              contribution: '+0.20',
              strength: 'high' as const,
              provenance: 'beta evidence',
            }],
            {
              componentScores: {
                entityIntegrity: 1,
                semantic: 0.2,
                hardConstraintPass: true,
                softConstraint: 0.2,
                attributeAlignment: 0.1,
                preferenceAlignment: 0.1,
                popularity: 0.95,
                availability: 1,
                uncertaintyPenalty: 0.05,
              },
            },
          ),
        ],
        metadata: { coarsePruneSummary: undefined, rerankExecuted: false, rerankGateReason: undefined, runtimeSignal: undefined, preRerankTop5: [] },
      }),
    };
    const decisionEngine = { decide: vi.fn().mockResolvedValue(createDecisionOutput()) };
    const responseBuilder = createResponseBuilder();
    const useCase = makeHybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      ranker: ranker as never,
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      ltrModels: new Map([['known_item', createKnownItemLtrModel()]]),
    });

    await useCase.execute({ query: 'ridge cabernet' }, 'req-ltr');

    const decisionInput = decisionEngine.decide.mock.calls[0]?.[0];
    const responseParams = responseBuilder.build.mock.calls[0]?.[0];

    expect(decisionInput?.resolverResult.topEntity?.entityId).toBe(firstEntityId);
    expect(decisionInput?.evidenceSummary?.identityEvidencePresent).toBe(true);
    expect(decisionInput?.evidenceSummary?.identityEvidence?.rankedTopResultMatchesTopEntity).toBe(
      true,
    );
    expect(decisionInput?.evidenceItems).toEqual([
      {
        type: 'alpha',
        source: 'ranker',
        contribution: '+0.10',
        strength: 'medium',
        provenance: 'alpha evidence',
      },
    ]);
    expect(responseParams?.results[0]?.entity.entityId).toBe(firstEntityId);
    expect(responseParams?.retrievalModeSource).toBe('api_override');
    expect(responseParams?.plannerSuggestedMode).toBe('attribute_search');
    expect(responseParams).not.toHaveProperty('funnelMetrics');
    expect(responseParams?.counterfactuals).toEqual([
      expect.objectContaining({
        entityId: secondEntityId,
        canonicalLabel: 'Beta',
      }),
    ]);
  });

  it('uses the shared result mapper so hybrid responses can include drinking window predictions', async () => {
    const entityId = createEntityId();
    const plan = createPlan();
    const drinkingWindow = {
      check: vi.fn().mockResolvedValue({
        drinkingWindowStart: 2026,
        drinkingWindowEnd: 2032,
        peakYear: 2029,
        currentlyDrinkable: true,
        confidence: 'medium' as const,
        modelVersion: 'predictor-v1',
      }),
    };
    const responseBuilder = createResponseBuilder();
    const useCase = makeHybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      ranker: {
        rank: vi.fn().mockResolvedValue({
          results: [
            createRankedResult(entityId, 'Window Wine', 0.77, 1, [], {
              vintageYear: 2019,
              grapePrimaryEnc: 11,
              regionEnc: 22,
              countryEnc: 33,
              body: 3,
              tannin: 2,
              acidity: 4,
              sweetness: 1,
            }),
          ],
          metadata: { coarsePruneSummary: undefined, rerankExecuted: false, rerankGateReason: undefined, runtimeSignal: undefined, preRerankTop5: [] },
        }),
      } as never,
      responseBuilder: responseBuilder as never,
      drinkingWindow: drinkingWindow as never,
    });

    await useCase.execute({ query: 'window wine' }, 'req-window');

    const responseParams = responseBuilder.build.mock.calls[0]?.[0];

    expect(drinkingWindow.check).toHaveBeenCalledOnce();
    expect(drinkingWindow.check).toHaveBeenCalledWith(
      expect.objectContaining({
        targetYear: new Date().getFullYear(),
      }),
    );
    expect(responseParams?.results[0]?.drinkingWindow).toEqual({
      drinkingWindowStart: 2026,
      drinkingWindowEnd: 2032,
      peakYear: 2029,
      currentlyDrinkable: true,
      confidence: 'medium',
      modelVersion: 'predictor-v1',
    });
  });
});
