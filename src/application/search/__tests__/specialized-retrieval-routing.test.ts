import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchUseCase, type SearchUseCaseDeps } from '../search.usecase.js';
import { QuerySanitizer } from '../../../domain/security/service/query-sanitizer.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { HybridCandidate } from '../../../domain/retrieval/model/hybrid-candidate.js';
import type { RankedResult } from '../../../domain/ranking/model/ranked-result.js';
import { createEntityId } from '../../../domain/shared/types/index.js';
import { MixedRouteDegradationError } from '../../../domain/mixed/model/mixed-degradation.js';
import { createStageTimer } from '../../../observability/stage-timer.js';

function makePlan(overrides: Partial<QueryPlanV1>): QueryPlanV1 {
  return {
    rawQuery: 'opus one wines',
    normalizedQuery: 'opus one wines',
    intent: 'entity_exact',
    route: 'hybrid',
    retrievalMode: 'producer_browse',
    queryClass: 'catalog_browse',
    anchors: [
      {
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        candidateEntityIds: ['wine-1'],
        confidence: 0.95,
        source: 'alias',
      },
    ],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {},
    uncertainty: {
      overall: 'low',
      anchor_uncertainty: 'low',
      constraint_conflicts: false,
    },
    plannerVersion: 'test',
    policyRuleVersion: 'test',
    thresholdProfileId: 'default',
    ...overrides,
  };
}

function makeCandidate(entityId: string, label: string): HybridCandidate {
  return {
    entityId,
    canonicalLabel: label,
    producer: 'Opus One',
    retrievalFusionScore: 0.9,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'producer_browse',
      lexicalQueriesUsed: ['Opus One'],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: ['sparse_bm25', 'browse_producer'],
    },
  };
}

function makeRankedResult(entityId: string, label: string): RankedResult {
  return {
    entityId,
    canonicalLabel: label,
    finalScore: 0.91,
    rank: 1,
    componentScores: {
      semantic: 0.8,
      popularity: 0.6,
      attributeAlignment: 0.7,
      preferenceAlignment: 0.5,
      hardConstraintPass: true,
      softConstraint: 0.5,
      entityIntegrity: 0.9,
      availability: 1,
      uncertaintyPenalty: 0,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
  };
}

describe('SearchUseCase specialized retrieval routing', () => {
  let deps: SearchUseCaseDeps;

  beforeEach(() => {
    deps = {
      allowCompiledFallback: true,
      queryPlanner: {
        plan: vi.fn(),
      },
      entityResolver: {
        resolve: vi.fn().mockResolvedValue({
          status: 'resolved',
          topEntity: {
            entityId: 'wine-1',
            canonicalLabel: 'Opus One 2018',
            calibratedScore: 0.95,
          },
          candidates: [],
          decisionConfidenceC: 0.95,
          decisionTrace: {
            queryClass: 'catalog_browse',
            top1CalibratedScore: 0.95,
            top2CalibratedScore: 0.2,
            calibratedGap: 0.75,
            decisionConfidenceC: 0.95,
            ambiguityDetected: false,
            ambiguityTypes: [],
            appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
            outcomeReasonCodes: ['TEST'],
          },
          conformalSetSize: 1,
        }),
      },
      entityLookup: {
        getDocument: vi.fn().mockImplementation(async (id: unknown) => ({
          entityId: id,
          entityType: 'wine',
          canonicalLabel: 'Opus One 2018',
        })),
        getDocuments: vi.fn().mockImplementation(async (ids: readonly unknown[]) => {
          const map = new Map();
          for (const id of ids) {
            map.set(id, {
              entityId: id,
              entityType: 'wine',
              canonicalLabel: 'Opus One 2018',
            });
          }
          return map;
        }),
      },
      candidatePool: {
        generate: vi.fn(),
      },
      browseRetriever: {
        browseProducer: vi.fn(),
        browseRegion: vi.fn(),
      },
      compareRetriever: {
        compareAgainstAnchor: vi.fn(),
      },
      ranker: {
        rank: vi.fn().mockResolvedValue({
          results: [makeRankedResult('wine-1', 'Opus One 2018')],
          metadata: { coarsePruneSummary: undefined, rerankExecuted: false, rerankGateReason: undefined, runtimeSignal: undefined, preRerankTop5: [] },
        }),
      },
      decisionEngine: {
        decide: vi.fn().mockResolvedValue({
          decisionStatus: 'resolved',
          nextAction: 'return_result',
          decisionConfidence: 0.91,
          confidenceSemantics: 'calibrated_decision_confidence',
        }),
      },
      responseBuilder: {
        build: vi.fn().mockReturnValue({
          queryType: 'search',
          engineDecision: {
            decisionStatus: 'resolved',
            nextAction: 'return_result',
            route: 'hybrid',
            decisionConfidence: 0.91,
            confidenceSemantics: 'calibrated_decision_confidence',
            decisionTraceRef: 'trace-ref',
            decisionSnapshot: {
              model_versions: {},
              index_versions: {},
              policy_rule_version: 'test',
              threshold_profile_id: 'default',
              planner_version: 'test',
              feature_flags: {},
            },
          },
          results: [],
          clarification: null,
          meta: {
            requestId: 'req-1',
            queryTimeMs: 1,
            route: 'hybrid',
            version: 'test',
            engine_schema_version: 'search_response_v1',
            decisionSnapshot: {
              model_versions: {},
              index_versions: {},
              policy_rule_version: 'test',
              threshold_profile_id: 'default',
              planner_version: 'test',
              feature_flags: {},
            },
            response_hash: 'hash',
          },
        }),
      },
      mixedSolver: {
        solve: vi.fn(),
      },
      querySanitizer: new QuerySanitizer(),
    };
  });

  it('uses BrowseRetriever for producer browse queries before generic candidate pool', async () => {
    const plan = makePlan({});
    vi.mocked(deps.queryPlanner.plan).mockResolvedValue(plan);
    vi.mocked(deps.browseRetriever!.browseProducer).mockResolvedValue([
      makeCandidate('wine-1', 'Opus One 2018'),
    ]);

    const useCase = new SearchUseCase(deps);
    await useCase.execute({ query: 'opus one wines' }, 'req-1');

    expect(deps.browseRetriever?.browseProducer).toHaveBeenCalledWith(
      'Opus One',
      plan.constraints,
      20,
      // ADR-014 Phase 1b.3b: compiled.constraintGraph threaded through; fixture
      // compiles without a graph so this is undefined.
      undefined,
    );
    expect(deps.candidatePool.generate).not.toHaveBeenCalled();
  });

  it('records end-to-end stage timings on the main search path when a stageTimer is provided', async () => {
    const plan = makePlan({});
    vi.mocked(deps.queryPlanner.plan).mockResolvedValue(plan);
    vi.mocked(deps.browseRetriever!.browseProducer).mockResolvedValue([
      makeCandidate('wine-1', 'Opus One 2018'),
    ]);

    const useCase = new SearchUseCase(deps);
    const stageTimer = createStageTimer();
    await useCase.execute(
      { query: 'opus one wines' },
      'req-stage-timer',
      { stageTimer },
    );

    expect(stageTimer.snapshot()).toEqual(
      expect.objectContaining({
        'search.total': expect.any(Number),
        'search.pre_route': expect.any(Number),
        'search.route_execution': expect.any(Number),
        'search.post_route': expect.any(Number),
      }),
    );
  });

  it('uses CompareRetriever for compare_candidates queries', async () => {
    const plan = makePlan({
      rawQuery: 'opus one vs napa cabs',
      normalizedQuery: 'opus one vs napa cabs',
      intent: 'comparison_search',
      retrievalMode: 'compare_candidates',
      queryClass: 'comparison_query',
    });
    vi.mocked(deps.queryPlanner.plan).mockResolvedValue(plan);
    vi.mocked(deps.compareRetriever!.compareAgainstAnchor).mockResolvedValue([
      makeCandidate('wine-2', 'Ridge Monte Bello 2018'),
    ]);

    const useCase = new SearchUseCase(deps);
    await useCase.execute({ query: 'opus one vs napa cabs' }, 'req-2');

    expect(deps.compareRetriever?.compareAgainstAnchor).toHaveBeenCalledWith(
      'wine-1',
      plan.constraints,
      20,
      // ADR-014 Phase 1b.3b: compiled.constraintGraph threaded through.
      undefined,
    );
    expect(deps.candidatePool.generate).not.toHaveBeenCalled();
  });

  it('falls back to candidate-pool relative retrieval when compare retriever returns no candidates', async () => {
    const plan = makePlan({
      rawQuery: 'opus one vs napa cabs',
      normalizedQuery: 'opus one vs napa cabs',
      intent: 'comparison_search',
      retrievalMode: 'compare_candidates',
      queryClass: 'comparison_query',
    });
    vi.mocked(deps.queryPlanner.plan).mockResolvedValue(plan);
    vi.mocked(deps.compareRetriever!.compareAgainstAnchor).mockResolvedValue([]);
    vi.mocked(deps.candidatePool.generate).mockResolvedValue([
      makeCandidate('wine-3', 'Fallback Relative Candidate'),
    ]);

    const useCase = new SearchUseCase(deps);
    await useCase.execute({ query: 'opus one vs napa cabs' }, 'req-compare-fallback');

    expect(deps.compareRetriever?.compareAgainstAnchor).toHaveBeenCalledWith(
      'wine-1',
      plan.constraints,
      20,
      undefined,
    );
    expect(deps.candidatePool.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        queryPlan: plan,
        route: 'hybrid',
        anchorEntityId: 'wine-1',
      }),
    );
  });

  it('hydrates entity-route resolver candidates from entityLookup before resolve', async () => {
    const plan = makePlan({
      route: 'entity',
      retrievalMode: 'entity_lookup',
    });
    vi.mocked(deps.queryPlanner.plan).mockResolvedValue(plan);
    const wine1Doc = {
      entityId: createEntityId('wine-1'),
      entityType: 'wine' as const,
      canonicalLabel: 'Opus One 2018',
    };
    vi.mocked(deps.entityLookup!.getDocuments).mockResolvedValue(
      new Map([[createEntityId('wine-1'), wine1Doc]]),
    );

    const useCase = new SearchUseCase(deps);
    await useCase.execute({ query: 'Opus One' }, 'req-entity');

    expect(deps.entityLookup?.getDocuments).toHaveBeenCalledWith([createEntityId('wine-1')]);
    expect(deps.entityResolver.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateEntities: [
          expect.objectContaining({
            entityId: 'wine-1',
            canonicalLabel: 'Opus One 2018',
          }),
        ],
      }),
    );
  });

  it('surfaces mixed anchor failures as degraded response contracts instead of throwing', async () => {
    const plan = makePlan({
      rawQuery: 'opus one 같은 와인',
      normalizedQuery: 'opus one 같은 와인',
      intent: 'mixed_query',
      route: 'mixed',
      retrievalMode: 'similar_items',
      queryClass: 'anchored_similarity',
    });
    vi.mocked(deps.queryPlanner.plan).mockResolvedValue(plan);
    vi.mocked(deps.mixedSolver.solve).mockRejectedValue(
      new MixedRouteDegradationError(
        'mixed_anchor_resolution_failed',
        'anchor missing',
      ),
    );

    const useCase = new SearchUseCase(deps);
    await useCase.execute({ query: 'opus one 같은 와인' }, 'req-mixed-anchor');

    expect(deps.responseBuilder.build).toHaveBeenCalledWith(
      expect.objectContaining({
        contract: {
          executionMode: 'degraded',
          degradationReasons: ['mixed_anchor_resolution_failed'],
        },
      }),
    );
  });
});
