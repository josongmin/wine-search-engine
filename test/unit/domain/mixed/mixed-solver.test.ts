import { describe, expect, it, beforeEach, vi } from 'vitest';
import { MixedSolver } from '../../../../src/domain/mixed/service/mixed-solver.js';
import type {
  AnchorResolverPort,
  CandidateAttributePort,
  SimilarRetrievalPort,
} from '../../../../src/domain/mixed/port/mixed-query.port.js';
import type { AnchorProfiler } from '../../../../src/domain/mixed/service/anchor-profiler.js';
import type { SimilarityScorer } from '../../../../src/domain/mixed/service/similarity-scorer.js';
import type { ConstraintOverlay } from '../../../../src/domain/mixed/service/constraint-overlay.js';
import type { RankerPort } from '../../../../src/domain/ranking/port/ranker.port.js';
import type { CompiledWineQuery } from '../../../../src/domain/query/model/compiled-wine-query.js';
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { RankerRuntimeSignal } from '../../../../src/domain/ranking/model/ranking-runtime-signal.js';
import { createEntityId, type NormalizedConstraint } from '../../../../src/domain/shared/types/index.js';
import { MixedRouteDegradationError } from '../../../../src/domain/mixed/model/mixed-degradation.js';

function minimalPlan(): QueryPlanV1 {
  return {
    rawQuery: 'wines like opus one',
    normalizedQuery: 'wines like opus one',
    intent: 'mixed_query',
    route: 'mixed',
    retrievalMode: 'similar_items',
    queryClass: 'anchored_similarity',
    anchors: [
      {
        surfaceForm: 'Opus One',
        normalizedForm: 'opus one',
        confidence: 0.93,
        candidateEntityIds: [createEntityId('anchor-1')],
      },
    ],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: { lexical: [], semantic: [] },
    policy: {} as QueryPlanV1['policy'],
    uncertainty: {} as QueryPlanV1['uncertainty'],
    plannerVersion: '1.0.0',
    policyRuleVersion: '1.0.0',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

function minimalCompiled(): CompiledWineQuery {
  const plan = minimalPlan();
  return {
    query: {
      rawQuery: plan.rawQuery,
      normalizedQuery: plan.normalizedQuery,
      intent: plan.intent,
      queryClass: plan.queryClass,
      anchors: plan.anchors,
      constraints: plan.constraints,
      expansions: plan.expansions,
      uncertainty: plan.uncertainty,
      plannerVersion: plan.plannerVersion,
      policyRuleVersion: plan.policyRuleVersion,
      thresholdProfileId: plan.thresholdProfileId,
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'mixed',
      effectiveRetrievalMode: 'similar_items',
      routeSource: 'planner',
      budget: { maxCandidates: 100, enablePrecisionRerank: true },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: true,
      },
    },
  };
}

function buildSolver(runtimeSignal?: RankerRuntimeSignal): MixedSolver {
  const anchorResolver: AnchorResolverPort = {
    resolve: async () => ({
      entityId: createEntityId('anchor-1'),
      canonicalLabel: 'Opus One',
      region: 'Napa Valley',
      grapes: ['Cabernet Sauvignon'],
      body: 0.8,
      sweetness: 0.1,
      style: 'bold',
    }),
  };
  const anchorProfiler: AnchorProfiler = {
    buildProfile: (entity, confidence) => ({
      ...entity,
      anchorConfidence: confidence,
      embedding: [0.1, 0.2, 0.3],
    }),
  } as AnchorProfiler;
  const similarRetrieval: SimilarRetrievalPort = {
    retrieveSimilar: async () => [],
  };
  const candidateAttributes: CandidateAttributePort = {
    loadAttributes: async () => new Map(),
    loadSimilarityCandidate: async () => undefined,
  };
  const similarityScorer: SimilarityScorer = {
    score: () => 0.5,
  } as SimilarityScorer;
  const constraintOverlay: ConstraintOverlay = {
    apply: (rankedResults) => [...rankedResults],
  } as ConstraintOverlay;
  const ranker: RankerPort = {
    rank: async () => ({
      results: [],
      metadata: {
        coarsePruneSummary: undefined,
        rerankExecuted: false,
        rerankGateReason: undefined,
        runtimeSignal,
        preRerankTop5: [],
      },
    }),
    getLastFunnelMetrics: () => undefined,
  };

  return new MixedSolver(
    anchorResolver,
    anchorProfiler,
    similarRetrieval,
    candidateAttributes,
    similarityScorer,
    constraintOverlay,
    ranker,
  );
}

describe('MixedSolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with mixed_similar_retrieval_fallback when candidates are empty', async () => {
    const solver = buildSolver({
      rerankerStatus: 'failed',
      rerankerFailureReason: 'timeout',
      degradation: {
        executionMode: 'degraded',
        degradationReasons: ['reranker_timeout'],
      },
    });

    const result = await solver.solve(minimalPlan(), minimalCompiled());

    expect(result.routeDegradation).toEqual({
      executionMode: 'degraded',
      degradationReasons: ['mixed_similar_retrieval_fallback'],
    });
    expect(result.fallbackReason).toBe('mixed_similar_retrieval_fallback');
    expect(result.rankedResults).toHaveLength(0);
    expect(result.routeDegradation?.degradationReasons).not.toContain('mixed_ranker_unavailable');
  });

  it('returns early without calling ranker when candidates are empty', async () => {
    const solver = buildSolver({
      rerankerStatus: 'failed',
      rerankerFailureReason: 'unknown',
      degradation: {
        executionMode: 'advisory',
        degradationReasons: ['reranker_skipped'],
      },
    });

    const result = await solver.solve(minimalPlan(), minimalCompiled());

    expect(result.routeDegradation).toEqual({
      executionMode: 'degraded',
      degradationReasons: ['mixed_similar_retrieval_fallback'],
    });
    expect(result.fallbackReason).toBe('mixed_similar_retrieval_fallback');
    expect(result.rankedResults).toHaveLength(0);
  });

  it('fails closed when constraint overlay throws', async () => {
    const anchorResolver: AnchorResolverPort = {
      resolve: async () => ({
        entityId: createEntityId('anchor-1'),
        canonicalLabel: 'Opus One',
        region: 'Napa Valley',
        grapes: ['Cabernet Sauvignon'],
      }),
    };
    const anchorProfiler: AnchorProfiler = {
      buildProfile: (entity, confidence) => ({
        ...entity,
        anchorConfidence: confidence,
      }),
    } as AnchorProfiler;
    const similarRetrieval: SimilarRetrievalPort = {
      retrieveSimilar: async () => [{ entityId: createEntityId('candidate-1') } as never],
    };
    const candidateAttributes: CandidateAttributePort = {
      loadAttributes: async () => new Map(),
      loadSimilarityCandidate: async () => undefined,
    };
    const similarityScorer: SimilarityScorer = {
      score: () => 0.5,
    } as SimilarityScorer;
    const constraintOverlay: ConstraintOverlay = {
      apply: () => {
        throw new Error('overlay exploded');
      },
    } as ConstraintOverlay;
    const ranker: RankerPort = {
      rank: async () => ({
        results: [{
          entityId: createEntityId('candidate-1'),
          canonicalLabel: 'Candidate',
          finalScore: 0.7,
          rank: 1,
          matchedConstraints: [],
          unmetConstraints: [],
          inferredConstraints: [],
          evidenceItems: [],
          componentScores: {
            entityIntegrity: 1,
            semantic: 0.5,
            hardConstraintPass: true,
            softConstraint: 0.5,
            attributeAlignment: 0.5,
            preferenceAlignment: 0.5,
            popularity: 0.5,
            availability: 1,
            uncertaintyPenalty: 0,
          },
        } as never],
        metadata: {
          coarsePruneSummary: undefined,
          rerankExecuted: false,
          rerankGateReason: undefined,
          runtimeSignal: undefined,
          preRerankTop5: [],
        },
      }),
      getLastFunnelMetrics: () => undefined,
    };

    const solver = new MixedSolver(
      anchorResolver,
      anchorProfiler,
      similarRetrieval,
      candidateAttributes,
      similarityScorer,
      constraintOverlay,
      ranker,
    );

    await expect(solver.solve(minimalPlan(), minimalCompiled())).rejects.toMatchObject<Partial<MixedRouteDegradationError>>({
      reason: 'mixed_constraint_overlay_failed',
    });
  });

  it('threads hard constraints into similar retrieval before ranking', async () => {
    const hardConstraint: NormalizedConstraint = {
      attribute: 'wine_type',
      operator: '=',
      value: 'white',
      source: 'planner',
      source_tier: 'hard',
    };
    const plan = {
      ...minimalPlan(),
      constraints: {
        hard: [hardConstraint],
        soft: [],
        inferred: [],
      },
    };
    const retrieveSimilar = vi.fn<SimilarRetrievalPort['retrieveSimilar']>().mockResolvedValue([]);
    const anchorResolver: AnchorResolverPort = {
      resolve: async () => ({
        entityId: createEntityId('anchor-1'),
        canonicalLabel: 'Opus One',
        region: 'Napa Valley',
        grapes: ['Cabernet Sauvignon'],
      }),
    };
    const anchorProfiler: AnchorProfiler = {
      buildProfile: (entity, confidence) => ({
        ...entity,
        anchorConfidence: confidence,
        embedding: [0.1, 0.2, 0.3],
      }),
    } as AnchorProfiler;
    const candidateAttributes: CandidateAttributePort = {
      loadAttributes: async () => new Map(),
      loadSimilarityCandidate: async () => undefined,
    };
    const similarityScorer: SimilarityScorer = {
      score: () => 0.5,
    } as SimilarityScorer;
    const constraintOverlay: ConstraintOverlay = {
      apply: (rankedResults) => [...rankedResults],
    } as ConstraintOverlay;
    const ranker: RankerPort = {
      rank: async () => ({
        results: [],
        metadata: {
          coarsePruneSummary: undefined,
          rerankExecuted: false,
          rerankGateReason: undefined,
          runtimeSignal: undefined,
          preRerankTop5: [],
        },
      }),
      getLastFunnelMetrics: () => undefined,
    };
    const solver = new MixedSolver(
      anchorResolver,
      anchorProfiler,
      { retrieveSimilar },
      candidateAttributes,
      similarityScorer,
      constraintOverlay,
      ranker,
    );

    await solver.solve(plan, minimalCompiled());

    expect(retrieveSimilar).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: createEntityId('anchor-1') }),
      100,
      [hardConstraint],
    );
  });
});
