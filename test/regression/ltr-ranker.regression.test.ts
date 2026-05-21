/**
 * Regression: LTR runtime ranker behavior + feature extractor invariants
 *
 * Covers the SOTA++ learning-to-rank surface (retrieval.ltr-ranker):
 *   - ltr-feature-extractor: extractLTRFeatures determinism, vector dimensions,
 *     numeric bounds, Hangul-safe inputs, NaN-safety for missing fields.
 *   - lambdamart-ranker: scoreDocument schema-parity, weight/bias validation,
 *     clamp-to-[0,1] inference output.
 *   - ltr-ranker: rerank fallback when model is missing, deterministic
 *     tie-breaking, empty-list handling, saturation guard.
 *
 * No real ONNX/LambdaMART model is loaded — weights are mocked with the
 * uniform-prior schema (DEFAULT_HEURISTIC_WEIGHTS) which is the train-serve
 * cold-start prior.
 *
 * Append-only regression suite — never delete a case.
 */

import { describe, expect, it } from 'vitest';
import {
  extractLTRFeatures,
  rankingFeaturesToVector,
  LTR_FEATURE_DIMENSION,
  LTR_FEATURE_NAME_ORDER,
  LTR_FEATURE_SCHEMA_HASH,
  type LTRScoreComponents,
  type RankingFeatures,
} from '../../src/domain/ranking/service/ltr-feature-extractor.js';
import {
  scoreDocument,
  DEFAULT_HEURISTIC_WEIGHTS,
  type QueryClassWeights,
} from '../../src/domain/ranking/service/lambdamart-ranker.js';
import { LTRRanker } from '../../src/domain/ranking/service/ltr-ranker.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeScoreComponents(
  overrides: Partial<LTRScoreComponents> = {},
): LTRScoreComponents {
  return {
    semantic: 0.6,
    popularity: 0.4,
    attributeAlignment: 0.5,
    preferenceAlignment: 0.7,
    recency: 0.3,
    multilingualScore: 0.0,
    entityPosterior: 0.55,
    identityExactnessTier: 'exact',
    lanePresence: 'corroborated',
    ...overrides,
  };
}

function makeMockWeights(
  overrides: Partial<QueryClassWeights> = {},
): QueryClassWeights {
  return {
    queryClass: 'semantic_preference',
    featureSchemaHash: LTR_FEATURE_SCHEMA_HASH,
    weights: DEFAULT_HEURISTIC_WEIGHTS,
    bias: 0.0,
    trainingExampleCount: 100,
    ndcg5ValidationScore: 0.85,
    trainedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function assertAllFeaturesFinite(features: RankingFeatures): void {
  for (const name of LTR_FEATURE_NAME_ORDER) {
    const value = features[name];
    expect(Number.isFinite(value), `feature ${name} must be finite`).toBe(true);
    expect(Number.isNaN(value), `feature ${name} must not be NaN`).toBe(false);
  }
}

// ─── feature extractor: determinism + dimensions ──────────────────────────────

describe('LTR feature extractor — determinism and dimension invariants', () => {
  it('same input produces identical feature vector (determinism)', () => {
    const scores = makeScoreComponents();
    const f1 = extractLTRFeatures(scores);
    const f2 = extractLTRFeatures(scores);
    expect(f1).toEqual(f2);
    expect(rankingFeaturesToVector(f1)).toEqual(rankingFeaturesToVector(f2));
  });

  it('5x repeated extraction returns identical vectors (no hidden state)', () => {
    const scores = makeScoreComponents({ semantic: 0.42, popularity: 0.17 });
    const vectors = Array.from({ length: 5 }, () =>
      rankingFeaturesToVector(extractLTRFeatures(scores)),
    );
    const first = vectors[0]!;
    for (const v of vectors) {
      expect(v).toEqual(first);
    }
  });

  it('feature vector dimension is stable across diverse inputs', () => {
    const inputs: LTRScoreComponents[] = [
      makeScoreComponents(),
      makeScoreComponents({ identityExactnessTier: 'none' }),
      makeScoreComponents({ lanePresence: 'entity_only' }),
      {},
      { semantic: 0.99 },
    ];
    for (const input of inputs) {
      const vec = rankingFeaturesToVector(extractLTRFeatures(input));
      expect(vec.length).toBe(LTR_FEATURE_DIMENSION);
      expect(LTR_FEATURE_NAME_ORDER.length).toBe(LTR_FEATURE_DIMENSION);
    }
  });

  it('feature vector order matches LTR_FEATURE_NAME_ORDER exactly', () => {
    const features = extractLTRFeatures(makeScoreComponents());
    const vec = rankingFeaturesToVector(features);
    for (let i = 0; i < LTR_FEATURE_NAME_ORDER.length; i++) {
      const name = LTR_FEATURE_NAME_ORDER[i]!;
      expect(vec[i]).toBe(features[name]);
    }
  });
});

// ─── feature extractor: numeric bounds ────────────────────────────────────────

describe('LTR feature extractor — numeric bounds', () => {
  it('every emitted feature is a finite number (no NaN/Infinity)', () => {
    const features = extractLTRFeatures(makeScoreComponents());
    assertAllFeaturesFinite(features);
  });

  it('identityExactnessTierScore is in the documented {0, 1/3, 2/3, 1} set', () => {
    const tiers: Array<['exact' | 'alias_exact' | 'alias_fuzzy' | 'none' | undefined, number]> = [
      ['exact', 1.0],
      ['alias_exact', 2 / 3],
      ['alias_fuzzy', 1 / 3],
      ['none', 0.0],
      [undefined, 0.0],
    ];
    for (const [tier, expected] of tiers) {
      const features = extractLTRFeatures(
        tier === undefined
          ? makeScoreComponents({})
          : makeScoreComponents({ identityExactnessTier: tier }),
      );
      if (tier === undefined) {
        // Need to clear the field — rebuild without it.
        const { identityExactnessTier: _omit, ...rest } = makeScoreComponents();
        const f = extractLTRFeatures(rest);
        expect(f.identityExactnessTierScore).toBe(0.0);
        continue;
      }
      expect(features.identityExactnessTierScore).toBeCloseTo(expected, 12);
    }
  });

  it('lane indicators (corroboration, disagreement, entityOnly, generalOnly) are in {0, 1}', () => {
    const cases: Array<['corroborated' | 'entity_only' | 'general_only', {
      corroborated: number; disagreement: number; entityOnly: number; generalOnly: number;
    }]> = [
      ['corroborated', { corroborated: 1, disagreement: 0, entityOnly: 0, generalOnly: 0 }],
      ['entity_only', { corroborated: 0, disagreement: 1, entityOnly: 1, generalOnly: 0 }],
      ['general_only', { corroborated: 0, disagreement: 1, entityOnly: 0, generalOnly: 1 }],
    ];
    for (const [presence, expected] of cases) {
      const f = extractLTRFeatures(makeScoreComponents({ lanePresence: presence }));
      expect(f.laneCorroborationScore).toBe(expected.corroborated);
      expect(f.laneDisagreementScore).toBe(expected.disagreement);
      expect(f.entityOnlyIndicator).toBe(expected.entityOnly);
      expect(f.generalOnlyIndicator).toBe(expected.generalOnly);
    }
  });

  it('bm25 and diversity remain 0.0 sentinel (documented placeholder)', () => {
    const f = extractLTRFeatures(makeScoreComponents());
    expect(f.bm25Score).toBe(0.0);
    expect(f.diversityScore).toBe(0.0);
  });
});

// ─── feature extractor: missing fields + Korean inputs ────────────────────────

describe('LTR feature extractor — missing fields and Hangul', () => {
  it('missing optional fields produce zero-defaults, not NaN', () => {
    const features = extractLTRFeatures({});
    assertAllFeaturesFinite(features);
    expect(features.semanticScore).toBe(0.0);
    expect(features.popularityScore).toBe(0.0);
    expect(features.recencyScore).toBe(0.0);
    expect(features.classMatchScore).toBe(0.0);
    expect(features.attributeMatchScore).toBe(0.0);
    expect(features.multilingualScore).toBe(0.0);
    expect(features.entityPosteriorScore).toBe(0.0);
    expect(features.identityExactnessTierScore).toBe(0.0);
    expect(features.laneCorroborationScore).toBe(0.0);
    expect(features.laneDisagreementScore).toBe(0.0);
    expect(features.entityOnlyIndicator).toBe(0.0);
    expect(features.generalOnlyIndicator).toBe(0.0);
  });

  it('Korean (Hangul) multilingual signal flows through extractor unchanged', () => {
    // The extractor does not see strings, but the Korean-query / Korean-alias
    // match signal arrives as a numeric multilingualScore. The extractor must
    // preserve it deterministically for any Hangul-derived candidate.
    const hangulSignals = [
      makeScoreComponents({ multilingualScore: 1.0 }), // "샤또 무똥" → Korean alias match
      makeScoreComponents({ multilingualScore: 0.0 }),
      makeScoreComponents({ multilingualScore: 0.5 }), // partial multilingual evidence
    ];
    for (const s of hangulSignals) {
      const f = extractLTRFeatures(s);
      assertAllFeaturesFinite(f);
      expect(f.multilingualScore).toBe(s.multilingualScore);
    }
  });

  it('rankingFeaturesToVector replaces injected NaN with 0.0 (NaN-safety guard)', () => {
    const features = extractLTRFeatures(makeScoreComponents());
    // Forge a NaN to confirm the vector projection guard.
    const corrupted: RankingFeatures = { ...features, semanticScore: Number.NaN };
    const vec = rankingFeaturesToVector(corrupted);
    expect(vec.length).toBe(LTR_FEATURE_DIMENSION);
    for (const v of vec) {
      expect(Number.isFinite(v)).toBe(true);
    }
    const semanticIdx = LTR_FEATURE_NAME_ORDER.indexOf('semanticScore');
    expect(vec[semanticIdx]).toBe(0.0);
  });
});

// ─── lambdamart-ranker: scoreDocument inference contract ──────────────────────

describe('LambdaMART scoreDocument — inference invariants', () => {
  it('produces a finite score in [0, 1] for any valid feature vector', () => {
    const features = extractLTRFeatures(makeScoreComponents());
    const weights = makeMockWeights();
    const score = scoreDocument(features, weights);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('rejects mismatched featureSchemaHash (train-serve skew tripwire)', () => {
    const features = extractLTRFeatures(makeScoreComponents());
    const weights = makeMockWeights({ featureSchemaHash: 'deadbeefdeadbeef' });
    expect(() => scoreDocument(features, weights)).toThrow(/schema mismatch/i);
  });

  it('rejects missing (empty) featureSchemaHash', () => {
    const features = extractLTRFeatures(makeScoreComponents());
    const weights = makeMockWeights({ featureSchemaHash: '' });
    expect(() => scoreDocument(features, weights)).toThrow(/schema missing/i);
  });

  it('rejects non-finite weights at the inference boundary (no fallback)', () => {
    const features = extractLTRFeatures(makeScoreComponents());
    const corruptedWeights = [...DEFAULT_HEURISTIC_WEIGHTS];
    corruptedWeights[0] = Number.NaN;
    const weights = makeMockWeights({ weights: corruptedWeights });
    expect(() => scoreDocument(features, weights)).toThrow(/invalid weights/i);
  });

  it('rejects non-finite bias at the inference boundary', () => {
    const features = extractLTRFeatures(makeScoreComponents());
    const weights = makeMockWeights({ bias: Number.POSITIVE_INFINITY });
    expect(() => scoreDocument(features, weights)).toThrow(/invalid bias/i);
  });
});

// ─── ltr-ranker: rerank, fallback, tie-breaking ───────────────────────────────

interface MinimalRankable {
  readonly entityId: string;
  readonly retrievalScore: number;
  readonly features: RankingFeatures;
  readonly originalRank: number;
}

function makeRankable(
  entityId: string,
  retrievalScore: number,
  originalRank: number,
  scoreOverrides: Partial<LTRScoreComponents> = {},
): MinimalRankable {
  return {
    entityId,
    retrievalScore,
    features: extractLTRFeatures(makeScoreComponents(scoreOverrides)),
    originalRank,
  };
}

describe('LTRRanker.rerank — runtime ranking behavior', () => {
  it('empty candidate list returns empty output and does not throw', () => {
    const out = LTRRanker.rerank([], 'semantic_preference', makeMockWeights());
    expect(out.documents).toEqual([]);
    expect(out.saturated).toBe(false);
  });

  it('returns heuristic ranking (retrievalScore) when model is missing/undefined', () => {
    const docs = [
      makeRankable('wine-a', 0.9, 1),
      makeRankable('wine-b', 0.7, 2),
      makeRankable('wine-c', 0.5, 3),
    ];
    const out = LTRRanker.rerank(docs, 'semantic_preference', undefined);
    expect(out.saturated).toBe(false);
    expect(out.documents).toHaveLength(3);
    // Preserves original order (no model = no rerank).
    expect(out.documents.map((d) => d.entityId)).toEqual(['wine-a', 'wine-b', 'wine-c']);
    for (const d of out.documents) {
      expect(d.ltrScore).toBe(d.retrievalScore);
      expect(Number.isFinite(d.ltrScore)).toBe(true);
    }
  });

  it('mixed Korean + English candidates rerank deterministically in the same batch', () => {
    const docs = [
      makeRankable('wine-en-opus-one', 0.6, 1, { semantic: 0.8 }),
      makeRankable('wine-kr-샤또무똥', 0.8, 2, { semantic: 0.9, multilingualScore: 1.0 }),
      makeRankable('wine-kr-동방신주', 0.5, 3, { semantic: 0.4, multilingualScore: 1.0 }),
      makeRankable('wine-en-screaming-eagle', 0.7, 4, { semantic: 0.6 }),
    ];
    const out = LTRRanker.rerank(docs, 'semantic_preference', makeMockWeights());
    expect(out.documents).toHaveLength(4);
    // finalRank must be a contiguous 1..N permutation.
    const ranks = out.documents.map((d) => d.finalRank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4]);
    for (const d of out.documents) {
      expect(Number.isFinite(d.ltrScore)).toBe(true);
      expect(d.ltrScore).toBeGreaterThanOrEqual(0);
      expect(d.ltrScore).toBeLessThanOrEqual(1);
    }
  });

  it('equal LTR scores → deterministic tie-break by retrievalScore (descending)', () => {
    // Use uniform weights and identical features so every candidate produces
    // the same raw score. The ranker first ties on ltrScore, then breaks by
    // retrievalScore descending. With more than one identical ltrScore but a
    // single unique ltrScore total, the saturation guard triggers — verify
    // the saturated path explicitly with > 1 doc and a separate non-saturated
    // path here that has at least one distinguishing ltrScore.
    const sharedFeatures = extractLTRFeatures(makeScoreComponents());
    const docs: MinimalRankable[] = [
      { entityId: 'wine-z', retrievalScore: 0.5, features: sharedFeatures, originalRank: 1 },
      { entityId: 'wine-a', retrievalScore: 0.9, features: sharedFeatures, originalRank: 2 },
      // One doc with different features so unique ltrScores > 1, bypassing
      // the saturation fallback and exercising the actual sort/tiebreak.
      {
        entityId: 'wine-m',
        retrievalScore: 0.7,
        features: extractLTRFeatures(makeScoreComponents({ semantic: 0.99, popularity: 0.99 })),
        originalRank: 3,
      },
    ];
    const out = LTRRanker.rerank(docs, 'semantic_preference', makeMockWeights());
    expect(out.saturated).toBe(false);
    // Among the two tied-on-ltrScore docs, wine-a (retrievalScore 0.9) must
    // outrank wine-z (retrievalScore 0.5).
    const positions = new Map(out.documents.map((d, i) => [d.entityId, i]));
    expect(positions.get('wine-a')! < positions.get('wine-z')!).toBe(true);
  });

  it('saturated LTR scores (all identical) fall back to heuristic and flag saturated=true', () => {
    const sharedFeatures = extractLTRFeatures(makeScoreComponents());
    const docs: MinimalRankable[] = [
      { entityId: 'wine-a', retrievalScore: 0.9, features: sharedFeatures, originalRank: 1 },
      { entityId: 'wine-b', retrievalScore: 0.7, features: sharedFeatures, originalRank: 2 },
      { entityId: 'wine-c', retrievalScore: 0.5, features: sharedFeatures, originalRank: 3 },
    ];
    const out = LTRRanker.rerank(docs, 'semantic_preference', makeMockWeights());
    expect(out.saturated).toBe(true);
    // Saturated fallback uses retrievalScore as ltrScore and preserves input order.
    expect(out.documents.map((d) => d.entityId)).toEqual(['wine-a', 'wine-b', 'wine-c']);
    for (const d of out.documents) {
      expect(d.ltrScore).toBe(d.retrievalScore);
    }
  });
});

// ─── blendScores + measureRerankingShift sanity ───────────────────────────────

describe('LTRRanker.blendScores and measureRerankingShift', () => {
  it('blendScores at alpha=0 returns retrieval; at alpha=1 returns LTR', () => {
    expect(LTRRanker.blendScores(0.8, 0.2, 0)).toBeCloseTo(0.8, 12);
    expect(LTRRanker.blendScores(0.8, 0.2, 1)).toBeCloseTo(0.2, 12);
    expect(LTRRanker.blendScores(0.8, 0.2, 0.5)).toBeCloseTo(0.5, 12);
  });

  it('measureRerankingShift returns 0 for identical orderings', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(LTRRanker.measureRerankingShift(order, order)).toBe(0);
  });

  it('measureRerankingShift is finite and non-negative for any reorder', () => {
    const before = ['a', 'b', 'c', 'd'];
    const after = ['d', 'c', 'b', 'a'];
    const shift = LTRRanker.measureRerankingShift(before, after);
    expect(Number.isFinite(shift)).toBe(true);
    expect(shift).toBeGreaterThanOrEqual(0);
  });
});
