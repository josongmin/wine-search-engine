import { describe, expect, it } from 'vitest';
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
import type { QueryPlanV1 } from '../../../../src/domain/query/model/query-plan.js';
import type { RankerRuntimeSignal } from '../../../../src/domain/ranking/model/ranking-runtime-signal.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

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

function buildSolver(runtimeSignal?: RankerRuntimeSignal): MixedSolver {
  const anchorResolver: AnchorResolverPort = {
    resolve: async () => ({
      entityId: createEntityId('anchor-1'),
      canonicalLabel: 'Opus One',
      region: 'Napa Valley',
      grapes: ['Cabernet Sauvignon'],
      body: 4,
      sweetness: 1,
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
    rank: async () => [],
    getLastRuntimeSignal: () => runtimeSignal,
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
  it('reuses ranker degradation reasons without adding mixed-only labels', async () => {
    const solver = buildSolver({
      rerankerStatus: 'failed',
      rerankerFailureReason: 'timeout',
      degradation: {
        executionMode: 'degraded',
        degradationReasons: ['reranker_timeout'],
      },
    });

    const result = await solver.solve(minimalPlan());

    expect(result.routeDegradation).toEqual({
      executionMode: 'degraded',
      degradationReasons: [
        'reranker_timeout',
        'mixed_similar_retrieval_fallback',
      ],
    });
    expect(result.fallbackReason).toBe('mixed_similar_retrieval_fallback');
    expect(result.routeDegradation?.degradationReasons).not.toContain('mixed_ranker_unavailable');
  });

  it('preserves non-degraded ranker execution modes on the mixed route', async () => {
    const solver = buildSolver({
      rerankerStatus: 'failed',
      rerankerFailureReason: 'unknown',
      degradation: {
        executionMode: 'advisory',
        degradationReasons: ['reranker_skipped'],
      },
    });

    const result = await solver.solve(minimalPlan());

    expect(result.routeDegradation).toEqual({
      executionMode: 'advisory',
      degradationReasons: [
        'reranker_skipped',
        'mixed_similar_retrieval_fallback',
      ],
    });
  });
});
