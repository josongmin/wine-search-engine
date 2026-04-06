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

describe('HybridUseCase', () => {
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
        matchedConstraints: [],
        retrievalTrace: {
          retrievalProfile: 'producer_browse',
          lexicalQueriesUsed: ['ridge vineyards'],
          semanticQueriesUsed: ['ridge vineyards'],
          filtersApplied: [],
          candidateSources: ['browse'],
        },
      }]),
      browseRegion: vi.fn(),
    };
    const candidatePool = { generate: vi.fn() };
    const ranker = { rank: vi.fn().mockResolvedValue([]) };
    const decisionEngine = { decide: vi.fn().mockResolvedValue(createDecisionOutput()) };
    const responseBuilder = createResponseBuilder();
    const useCase = new HybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      candidatePool: candidatePool as never,
      browseRetriever: browseRetriever as never,
      ranker: ranker as never,
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      querySanitizer: safeSanitizer as never,
    });

    await useCase.execute({ query: 'Ridge Vineyards' }, 'req-browse');

    expect(browseRetriever.browseProducer).toHaveBeenCalledWith(
      'Ridge Vineyards',
      plan.constraints,
      20,
    );
    expect(candidatePool.generate).not.toHaveBeenCalled();
  });

  it('applies shared LTR reranking before synthetic resolve and decision assembly', async () => {
    const firstEntityId = createEntityId();
    const secondEntityId = createEntityId();
    const plan = createPlan();
    const ranker = {
      rank: vi.fn().mockResolvedValue([
        {
          entityId: firstEntityId,
          canonicalLabel: 'Alpha',
          finalScore: 0.82,
          rank: 1,
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
          matchedConstraints: [],
          unmetConstraints: [],
          inferredConstraints: [],
          evidenceItems: [{
            type: 'alpha',
            source: 'ranker',
            contribution: '+0.10',
            strength: 'medium' as const,
            provenance: 'alpha evidence',
          }],
        },
        {
          entityId: secondEntityId,
          canonicalLabel: 'Beta',
          finalScore: 0.79,
          rank: 2,
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
          matchedConstraints: [],
          unmetConstraints: [],
          inferredConstraints: [],
          evidenceItems: [{
            type: 'beta',
            source: 'ranker',
            contribution: '+0.20',
            strength: 'high' as const,
            provenance: 'beta evidence',
          }],
        },
      ]),
    };
    const decisionEngine = { decide: vi.fn().mockResolvedValue(createDecisionOutput()) };
    const responseBuilder = createResponseBuilder();
    const useCase = new HybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      candidatePool: { generate: vi.fn().mockResolvedValue([]) } as never,
      ranker: ranker as never,
      decisionEngine: decisionEngine as never,
      responseBuilder: responseBuilder as never,
      ltrModels: new Map([[
        'known_item',
        {
          queryClass: 'known_item',
          weights: [0, 0, 1, 0, 0, 0, 0, 0],
          bias: 0,
          trainingExampleCount: 1,
          ndcg5ValidationScore: 1,
          trainedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]]),
      querySanitizer: safeSanitizer as never,
    });

    await useCase.execute({ query: 'ridge cabernet' }, 'req-ltr');

    const decisionInput = decisionEngine.decide.mock.calls[0]?.[0];
    const responseParams = responseBuilder.build.mock.calls[0]?.[0];

    expect(decisionInput?.resolverResult.topEntity?.entityId).toBe(secondEntityId);
    expect(decisionInput?.evidenceSummary?.identityEvidencePresent).toBe(true);
    expect(decisionInput?.evidenceSummary?.identityEvidence?.rankedTopResultMatchesTopEntity).toBe(
      true,
    );
    expect(decisionInput?.evidenceItems).toEqual([
      {
        type: 'beta',
        source: 'ranker',
        contribution: '+0.20',
        strength: 'high',
        provenance: 'beta evidence',
      },
    ]);
    expect(responseParams?.results[0]?.entity.entityId).toBe(secondEntityId);
  });

  it('uses the shared result mapper so hybrid responses can include drinking window predictions', async () => {
    const entityId = createEntityId();
    const plan = createPlan();
    const drinkingWindow = {
      check: vi.fn().mockResolvedValue({
        drinkingWindowStart: 2026,
        drinkingWindowEnd: 2032,
        currentlyDrinkable: true,
        confidence: 'medium' as const,
        modelVersion: 'predictor-v1',
      }),
    };
    const responseBuilder = createResponseBuilder();
    const useCase = new HybridUseCase({
      queryPlanner: { plan: vi.fn().mockResolvedValue(plan) } as never,
      candidatePool: { generate: vi.fn().mockResolvedValue([]) } as never,
      ranker: {
        rank: vi.fn().mockResolvedValue([{
          entityId,
          canonicalLabel: 'Window Wine',
          finalScore: 0.77,
          rank: 1,
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
          matchedConstraints: [],
          unmetConstraints: [],
          inferredConstraints: [],
          evidenceItems: [],
          vintage: 2019,
          grapePrimaryEnc: 11,
          regionEnc: 22,
          countryEnc: 33,
          body: 3,
          tannin: 2,
          acidity: 4,
          sweetness: 1,
        }]),
      } as never,
      decisionEngine: { decide: vi.fn().mockResolvedValue(createDecisionOutput()) } as never,
      responseBuilder: responseBuilder as never,
      drinkingWindow: drinkingWindow as never,
      querySanitizer: safeSanitizer as never,
    });

    await useCase.execute({ query: 'window wine' }, 'req-window');

    const responseParams = responseBuilder.build.mock.calls[0]?.[0];

    expect(drinkingWindow.check).toHaveBeenCalledOnce();
    expect(responseParams?.results[0]?.drinkingWindow).toEqual({
      drinkingWindowStart: 2026,
      drinkingWindowEnd: 2032,
      currentlyDrinkable: true,
      confidence: 'medium',
      modelVersion: 'predictor-v1',
    });
  });
});
