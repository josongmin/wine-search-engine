/**
 * Regression: T-E6-02 — Rerank Normalization Failure Contract
 *
 * When cross-encoder reranking runs but score normalization fails
 * (collapsed/NaN score batch), the RerankDecision must report:
 *   - applied === false
 *   - decision === 'normalization_failed'
 *   - gateReason explaining the failure
 *
 * Previously, normalization failure was silent: applied=true, decision='applied',
 * making it indistinguishable from a successful rerank.
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, it, expect, vi } from 'vitest';
import { Ranker } from '../../src/domain/ranking/service/ranker.js';
import { SignalComputer } from '../../src/domain/ranking/service/signal-computer.js';
import { ScoreAggregator } from '../../src/domain/ranking/service/score-aggregator.js';
import { EvidenceMapper } from '../../src/domain/ranking/service/evidence-mapper.js';
import type { RerankerPort, RerankResult } from '../../src/domain/ranking/port/reranker.port.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { RankingInput } from '../../src/domain/ranking/model/ranking-input.js';
import type { CompiledWineQuery } from '../../src/domain/query/model/compiled-wine-query.js';
import type { ComponentScores } from '../../src/domain/ranking/model/ranked-result.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const NEUTRAL_COMPONENT_SCORES: ComponentScores = {
  entityIntegrity: 0.8,
  anchorSimilarity: 0,
  semantic: 0.5,
  softConstraint: 0.5,
  attributeAlignment: 0.5,
  preferenceAlignment: 0.5,
  popularity: 0.5,
  availability: 0.5,
  producerPrestige: 0,
  recency: 0,
  criticScore: 0,
  multilingualScore: 0,
  hardConstraintPass: true,
  finalScore: 0.5,
};

function makeCandidate(entityId: string): HybridCandidate {
  return {
    entityId,
    canonicalLabel: `Wine ${entityId}`,
    fusionRrfTotal: 0.5,
    matchedConstraints: [],
    retrievalTrace: {
      candidateSources: [],
      fusionInputs: [],
    },
  };
}

function makeRankingInput(
  candidates: readonly HybridCandidate[],
  queryClass = 'semantic_preference',
): RankingInput {
  const route = 'browse';
  return {
    queryPlan: {
      rawQuery: 'test wine',
      normalizedQuery: 'test wine',
      intent: 'known_entity',
      route,
      retrievalMode: 'hybrid',
      queryClass,
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {
        allowAbstain: false,
        allowClarify: false,
        enforceHardConstraints: true,
      },
      uncertainty: { level: 'low', sources: [] },
    },
    candidates,
    constraints: { hard: [], soft: [], inferred: [] },
    compiled: {
      query: {
        rawQuery: 'test wine', normalizedQuery: 'test wine', intent: 'known_entity',
        queryClass, anchors: [], constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] }, uncertainty: { level: 'low', sources: [] },
        plannerVersion: '1.0.0', policyRuleVersion: '1.0.0', thresholdProfileId: 'default-v1',
        retrievalPlan: { hardFilterTokens: [], softBoosts: [], inferredBoosts: [], sensoryPriors: [], planVersion: 'retrieval-plan-v1.0' },
      },
      execution: {
        effectiveRoute: route, effectiveRetrievalMode: 'hybrid',
        routeSource: 'planner',
        budget: { maxCandidates: 20, enablePrecisionRerank: true },
        provenancePolicy: { requireIdentitySeal: false, requireConstraintEvidence: false, requireAnchorEvidence: false },
      },
    } as CompiledWineQuery,
  };
}

function makeRankerWithReranker(reranker: RerankerPort): Ranker {
  const signalComputer = {
    computeAll: vi.fn().mockReturnValue(NEUTRAL_COMPONENT_SCORES),
    computeEntityPosterior: vi.fn().mockReturnValue(undefined),
    computeIdentityExactnessTier: vi.fn().mockReturnValue('none'),
    computeLanePresence: vi.fn().mockReturnValue(undefined),
  } as unknown as SignalComputer;

  const scoreAggregator = {
    aggregate: vi.fn().mockReturnValue(0.5),
  } as unknown as ScoreAggregator;

  const evidenceMapper = {
    mapToEvidence: vi.fn().mockReturnValue([]),
  } as unknown as EvidenceMapper;

  return new Ranker(signalComputer, scoreAggregator, evidenceMapper, {
    reranker,
  });
}

// ─── Test 1: All-NaN reranker scores → normalization_failed ──────────────────

describe('T-E6-02 Rerank Normalization Failure: all NaN scores', () => {
  it('returns applied=false and decision=normalization_failed when all reranker scores are NaN', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-${i}`));

    // Cross-encoder returns NaN scores for all candidates
    const mockReranker: RerankerPort = {
      rerank: vi.fn().mockResolvedValue(
        candidates.map((c, i): RerankResult => ({
          entityId: c.entityId,
          score: NaN,
          rank: i + 1,
        })),
      ),
    };

    const ranker = makeRankerWithReranker(mockReranker);
    const input = makeRankingInput(candidates);
    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(false);
    expect(decision!.decision).toBe('normalization_failed');
    // Runtime signal should reflect degradation
    expect(output.metadata.runtimeSignal).toBeDefined();
    expect(output.metadata.runtimeSignal!.degradation).toBeDefined();
    expect(output.metadata.runtimeSignal!.degradation!.degradationReasons).toContain(
      'reranker_score_normalization_failed',
    );
  });
});

// ─── Test 2: Collapsed scores (all identical) → normalization_failed ─────────

describe('T-E6-02 Rerank Normalization Failure: collapsed scores', () => {
  it('returns applied=false and decision=normalization_failed when all scores are identical', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-${i}`));

    // Cross-encoder returns identical scores → rawRange ≈ 0 < epsilon
    const mockReranker: RerankerPort = {
      rerank: vi.fn().mockResolvedValue(
        candidates.map((c, i): RerankResult => ({
          entityId: c.entityId,
          score: 0.5,
          rank: i + 1,
        })),
      ),
    };

    const ranker = makeRankerWithReranker(mockReranker);
    const input = makeRankingInput(candidates);
    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(false);
    expect(decision!.decision).toBe('normalization_failed');
  });
});

// ─── Test 3: Normal score spread → applied (positive control) ────────────────

describe('T-E6-02 Rerank Normalization Failure: normal scores → applied', () => {
  it('returns applied=true when scores have normal spread', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-${i}`));

    // Cross-encoder returns well-spread scores
    const mockReranker: RerankerPort = {
      rerank: vi.fn().mockResolvedValue(
        candidates.map((c, i): RerankResult => ({
          entityId: c.entityId,
          score: 10 - i * 2, // 10, 8, 6, 4, 2, 0 — clear spread
          rank: i + 1,
        })),
      ),
    };

    const ranker = makeRankerWithReranker(mockReranker);
    const input = makeRankingInput(candidates);
    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(true);
    expect(decision!.decision).toBe('applied');
  });
});
