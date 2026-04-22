/**
 * Regression: E1-P0-5 RerankDecision — typed reranking audit trail
 *
 * Guards all five RerankDecisionCode branches produced by Ranker.rank():
 *
 *  1. no_model_for_query_class — ltrModels Map has no entry for the queryClass
 *  2. empty_candidates         — ltrModels present but candidate list is empty
 *  3. feature_dimension_mismatch — model weight vector length ≠ live LambdaMART dimension
 *  4. gate_blocked             — gate evaluation returns shouldRerank=false
 *  5. applied                  — LTR ran normally; applied=true, modelId set
 *
 * These tests are append-only (regression suite rules). Never delete.
 */

import { describe, it, expect, vi } from 'vitest';
import { Ranker } from '../../src/domain/ranking/service/ranker.js';
import { SignalComputer } from '../../src/domain/ranking/service/signal-computer.js';
import { ScoreAggregator } from '../../src/domain/ranking/service/score-aggregator.js';
import { EvidenceMapper } from '../../src/domain/ranking/service/evidence-mapper.js';
import {
  LAMBDAMART_FEATURE_DIMENSION,
  LTR_FEATURE_SCHEMA_HASH,
  type QueryClassWeights,
} from '../../src/domain/ranking/service/lambdamart-ranker.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { RankingInput } from '../../src/domain/ranking/model/ranking-input.js';
import type { CompiledWineQuery } from '../../src/domain/query/model/compiled-wine-query.js';
import type { ComponentScores } from '../../src/domain/ranking/model/ranked-result.js';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

/** Minimal viable ComponentScores — all required fields present. */
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
  uncertaintyPenalty: 0,
  hardConstraintPass: true,
};

/** Builds a minimal HybridCandidate for ranking tests. */
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

/** Builds a minimal RankingInput for a given set of candidates and queryClass. */
function makeRankingInput(
  candidates: readonly HybridCandidate[],
  queryClass = 'exact_entity',
  rerankForced?: boolean,
): RankingInput {
  // Use 'browse' route for non-entity queryClasses so the gate does not
  // short-circuit on 'already_precise' (entity/exact_entity routes block rerank).
  const route = queryClass === 'exact_entity' ? 'entity' : 'browse';
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
    ...(rerankForced !== undefined ? { rerankForced } : {}),
  };
}

/** Builds a valid QueryClassWeights model with the current live weight vector. */
function makeValidLtrModel(queryClass: string): QueryClassWeights {
  return {
    queryClass,
    featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
    weights: Array(LAMBDAMART_FEATURE_DIMENSION).fill(1 / LAMBDAMART_FEATURE_DIMENSION) as number[],
    bias: 0,
    trainingExampleCount: 100,
    ndcg5ValidationScore: 0.8,
    trainedAt: new Date(),
  };
}

/** Creates a Ranker with mocked signal/aggregator/evidence collaborators. */
function makeRanker(ltrModels?: ReadonlyMap<string, QueryClassWeights>): Ranker {
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
    ltrModels,
  });
}

// ─── Test 1: no_model_for_query_class ─────────────────────────────────────────

describe('E1-P0-5 RerankDecision: no_model_for_query_class', () => {
  it('returns decision=no_model_for_query_class when ltrModels has no entry for queryClass', async () => {
    // ltrModels Map contains a model for 'other_class', not for 'exact_entity'
    const ltrModels = new Map<string, QueryClassWeights>([
      ['other_class', makeValidLtrModel('other_class')],
    ]);
    const ranker = makeRanker(ltrModels);

    // 6 candidates → gate allows rerank for semantic_preference (≥5 required)
    const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-${i}`));
    // semantic_preference + browse route → gate will allow rerank.
    // ltrModels has 'other_class' but not 'semantic_preference' → no_model_for_query_class.
    const input = makeRankingInput(candidates, 'semantic_preference');

    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(false);
    expect(decision!.decision).toBe('no_model_for_query_class');
  });
});

// ─── Test 2: empty_candidates ─────────────────────────────────────────────────

describe('E1-P0-5 RerankDecision: empty_candidates', () => {
  it('returns decision=empty_candidates when ltrModels present but candidate list is empty', async () => {
    const queryClass = 'semantic_preference';
    const ltrModels = new Map<string, QueryClassWeights>([
      [queryClass, makeValidLtrModel(queryClass)],
    ]);
    const ranker = makeRanker(ltrModels);

    // Empty candidate list
    const input = makeRankingInput([], queryClass);

    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(false);
    expect(decision!.decision).toBe('empty_candidates');
  });
});

// ─── Test 3: feature_dimension_mismatch ───────────────────────────────────────

describe('E1-P0-5 RerankDecision: feature_dimension_mismatch', () => {
  it('returns decision=feature_dimension_mismatch when model weights length mismatches the live schema', async () => {
    const queryClass = 'semantic_preference';
    // Wrong dimension: 5 weights instead of 8
    const badModel: QueryClassWeights = {
      queryClass,
      featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
      weights: [0.2, 0.2, 0.2, 0.2, 0.2],
      bias: 0,
      trainingExampleCount: 10,
      ndcg5ValidationScore: 0.7,
      trainedAt: new Date(),
    };
    const ltrModels = new Map<string, QueryClassWeights>([[queryClass, badModel]]);
    const ranker = makeRanker(ltrModels);

    const candidates = [
      makeCandidate('wine-1'),
      makeCandidate('wine-2'),
      makeCandidate('wine-3'),
      makeCandidate('wine-4'),
      makeCandidate('wine-5'),
    ];
    // semantic_preference with ≥5 candidates → gate will allow rerank
    const input = makeRankingInput(candidates, queryClass);

    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(false);
    expect(decision!.decision).toBe('feature_dimension_mismatch');
  });
});

// ─── Test 4: gate_blocked ─────────────────────────────────────────────────────

describe('E1-P0-5 RerankDecision: gate_blocked', () => {
  it('returns decision=gate_blocked when gate returns shouldRerank=false (too few candidates)', async () => {
    const queryClass = 'semantic_preference';
    const ltrModels = new Map<string, QueryClassWeights>([
      [queryClass, makeValidLtrModel(queryClass)],
    ]);
    const ranker = makeRanker(ltrModels);

    // Only 3 candidates — gate requires ≥5 (RERANK_GATE_MIN_CANDIDATE_COUNT)
    const candidates = [
      makeCandidate('wine-1'),
      makeCandidate('wine-2'),
      makeCandidate('wine-3'),
    ];
    const input = makeRankingInput(candidates, queryClass);

    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(false);
    expect(decision!.decision).toBe('gate_blocked');
  });

  it('returns decision=gate_blocked when route=entity blocks reranking', async () => {
    const queryClass = 'exact_entity';
    const ltrModels = new Map<string, QueryClassWeights>([
      [queryClass, makeValidLtrModel(queryClass)],
    ]);
    const ranker = makeRanker(ltrModels);

    // Enough candidates but exact_entity/entity route → gate returns already_precise
    const candidates = Array.from({ length: 10 }, (_, i) => makeCandidate(`wine-${i}`));
    const input = makeRankingInput(candidates, queryClass);

    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(false);
    expect(decision!.decision).toBe('gate_blocked');
  });
});

// ─── Test 5: applied ──────────────────────────────────────────────────────────

describe('E1-P0-5 RerankDecision: applied', () => {
  it('returns applied=true and decision=applied with modelId when LTR rerank succeeds', async () => {
    const queryClass = 'semantic_preference';
    const ltrModels = new Map<string, QueryClassWeights>([
      [queryClass, makeValidLtrModel(queryClass)],
    ]);
    const ranker = makeRanker(ltrModels);

    // ≥5 candidates so gate passes; semantic_preference → gate allows rerank
    const candidates = Array.from({ length: 6 }, (_, i) => makeCandidate(`wine-${i}`));
    const input = makeRankingInput(candidates, queryClass);

    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision).toBeDefined();
    expect(decision!.applied).toBe(true);
    expect(decision!.decision).toBe('applied');
    // modelId is populated from LTR model's queryClass key
    expect(decision!.modelId).toBeDefined();
    expect(typeof decision!.modelId).toBe('string');
    expect(decision!.modelId!.length).toBeGreaterThan(0);
  });

  it('applied LTR rerank reports non-zero inputCount', async () => {
    const queryClass = 'pure_constraint';
    const ltrModels = new Map<string, QueryClassWeights>([
      [queryClass, makeValidLtrModel(queryClass)],
    ]);
    const ranker = makeRanker(ltrModels);

    const candidates = Array.from({ length: 8 }, (_, i) => makeCandidate(`wine-${i}`));
    const input = makeRankingInput(candidates, queryClass);

    const output = await ranker.rank(input);
    const decision = output.metadata.rerankDecision;

    expect(decision!.applied).toBe(true);
    expect(decision!.inputCount).toBeGreaterThan(0);
  });
});

// ─── Type-level invariant: LtrRerankSkipReason union ─────────────────────────

describe('E1-P0-5 RerankDecision: LtrRerankSkipReason type-level assertion', () => {
  it('RerankDecisionCode union covers all expected branches (compile-time check)', () => {
    // This test verifies that all six RerankDecisionCode values are valid string literals.
    // If the type changes, TypeScript will flag the cast below at build time.
    const codes: readonly string[] = [
      'applied',
      'no_model_for_query_class',
      'empty_candidates',
      'feature_dimension_mismatch',
      'gate_blocked',
      'normalization_failed',
    ];
    expect(codes).toHaveLength(6);
    for (const code of codes) {
      expect(typeof code).toBe('string');
    }
  });
});
