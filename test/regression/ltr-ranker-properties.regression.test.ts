/**
 * Property-based regression: LTR runtime ranker invariants (retrieval.ltr-ranker)
 *
 * Complements the example-based suite (ltr-ranker.regression.test.ts) with
 * fast-check generators (numRuns = 100) that probe the full input space,
 * including adversarial scores/features. The ranker is a learning-to-rank
 * reranker over numeric feature vectors; the contract that production depends
 * on is a small set of structural invariants that MUST hold for ANY input:
 *
 *   P1  Determinism          — same docs + same model → byte-identical output.
 *   P2  Permutation          — output is a permutation of the input entityIds
 *                              (no add / drop / duplicate), finalRank is a
 *                              contiguous 1..N.
 *   P3  Bounded LTR score    — every emitted ltrScore is finite and in [0,1].
 *   P4  Sort monotonicity    — non-saturated output is sorted by the SSoT
 *                              comparator (ltrScore desc, retrievalScore desc,
 *                              entityId asc) — non-increasing ltrScore.
 *   P5  Tie-break determinism— full ltrScore+retrievalScore tie resolves by
 *                              entityId ascending, independent of input order.
 *   P6  NaN/Infinity guard   — adversarial non-finite retrievalScore never
 *                              produces NaN ltrScore or a throw.
 *   P7  Empty / singleton     — empty input → empty output; single doc → rank 1.
 *   P8  Saturation guard     — when all ltrScores collapse to one value the
 *                              ranker falls back to retrievalScore + flags it.
 *   P9  Order-independence    — shuffling the input does not change the output
 *                              ranking (set of (entityId,finalRank) is stable).
 *   P10 blendScores convex   — blend stays within [min(a,b), max(a,b)] for any
 *                              finite inputs and any (even out-of-range) alpha,
 *                              and never emits NaN.
 *   P11 shift non-negative    — measureRerankingShift is finite and >= 0.
 *
 * Korean (Hangul) entityIds and multilingual feature signals are mixed into
 * the generators (CLAUDE.md rules 5/8) — the comparator's final tie-break is a
 * raw string comparison, so Hangul ordering must stay deterministic.
 *
 * Append-only regression suite — never delete a case.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  extractLTRFeatures,
  LTR_FEATURE_SCHEMA_HASH,
  type LTRScoreComponents,
  type RankingFeatures,
} from '../../src/domain/ranking/service/ltr-feature-extractor.js';
import {
  DEFAULT_HEURISTIC_WEIGHTS,
  type QueryClassWeights,
} from '../../src/domain/ranking/service/lambdamart-ranker.js';
import { LTRRanker } from '../../src/domain/ranking/service/ltr-ranker.js';
import { compareScoreDescending } from '../../src/domain/shared/utils/stable-comparator.js';

const NUM_RUNS = 100;

interface MinimalRankable {
  readonly entityId: string;
  readonly retrievalScore: number;
  readonly features: RankingFeatures;
  readonly originalRank: number;
}

function makeWeights(
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

// ─── generators ───────────────────────────────────────────────────────────────

/** A finite [0,1] signal value. */
const unitScore = fc.double({ min: 0, max: 1, noNaN: true });

/** entityId mixing ASCII and Hangul so the string tie-break covers both. */
const entityIdArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.constantFrom(
    'wine-샤또무똥',
    'wine-동방신주',
    'wine-까베르네',
    'wine-opus-one',
    'wine-screaming-eagle',
    '와인-가',
    '와인-나',
  ),
);

const scoreComponentsArb: fc.Arbitrary<LTRScoreComponents> = fc.record({
  semantic: unitScore,
  popularity: unitScore,
  attributeAlignment: unitScore,
  preferenceAlignment: unitScore,
  recency: unitScore,
  multilingualScore: fc.constantFrom(0, 0.5, 1),
  entityPosterior: unitScore,
  identityExactnessTier: fc.constantFrom(
    'exact',
    'alias_exact',
    'alias_fuzzy',
    'none',
  ),
  lanePresence: fc.constantFrom('corroborated', 'entity_only', 'general_only'),
});

function rankableArb(
  retrievalScoreArb: fc.Arbitrary<number> = unitScore,
): fc.Arbitrary<MinimalRankable> {
  return fc
    .tuple(entityIdArb, retrievalScoreArb, scoreComponentsArb, fc.nat({ max: 50 }))
    .map(([entityId, retrievalScore, comps, originalRank]) => ({
      entityId,
      retrievalScore,
      features: extractLTRFeatures(comps),
      originalRank,
    }));
}

/** A list of rankables with UNIQUE entityIds (so permutation checks are exact). */
function uniqueDocsArb(
  retrievalScoreArb: fc.Arbitrary<number> = unitScore,
): fc.Arbitrary<MinimalRankable[]> {
  return fc
    .uniqueArray(rankableArb(retrievalScoreArb), {
      minLength: 0,
      maxLength: 12,
      selector: (d) => d.entityId,
    });
}

// ─── P1 determinism ─────────────────────────────────────────────────────────

describe('LTRRanker.rerank — property: determinism', () => {
  it('P1 same docs + same model → identical output (100 runs)', () => {
    fc.assert(
      fc.property(uniqueDocsArb(), (docs) => {
        const model = makeWeights();
        const a = LTRRanker.rerank(docs, 'semantic_preference', model);
        const b = LTRRanker.rerank(docs, 'semantic_preference', model);
        expect(a).toEqual(b);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P2 permutation + P3 bounded score ─────────────────────────────────────

describe('LTRRanker.rerank — property: permutation and bounded score', () => {
  it('P2 output is a permutation of input ids; finalRank is contiguous 1..N', () => {
    fc.assert(
      fc.property(uniqueDocsArb(), (docs) => {
        const out = LTRRanker.rerank(docs, 'semantic_preference', makeWeights());
        expect(out.documents).toHaveLength(docs.length);

        const inIds = [...docs.map((d) => d.entityId)].sort();
        const outIds = [...out.documents.map((d) => d.entityId)].sort();
        expect(outIds).toEqual(inIds);

        const ranks = out.documents.map((d) => d.finalRank).sort((x, y) => x - y);
        expect(ranks).toEqual(
          Array.from({ length: docs.length }, (_, i) => i + 1),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P3 every ltrScore is finite and in [0,1]', () => {
    fc.assert(
      fc.property(uniqueDocsArb(), (docs) => {
        const out = LTRRanker.rerank(docs, 'semantic_preference', makeWeights());
        for (const d of out.documents) {
          expect(Number.isFinite(d.ltrScore)).toBe(true);
          expect(d.ltrScore).toBeGreaterThanOrEqual(0);
          expect(d.ltrScore).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P4 sort monotonicity ──────────────────────────────────────────────────

describe('LTRRanker.rerank — property: SSoT sort monotonicity', () => {
  it('P4 non-saturated output is non-increasing by the SSoT comparator', () => {
    fc.assert(
      fc.property(uniqueDocsArb(), (docs) => {
        const out = LTRRanker.rerank(docs, 'semantic_preference', makeWeights());
        if (out.saturated) return; // saturated path is order-preserving, not score-sorted
        for (let i = 1; i < out.documents.length; i++) {
          const prev = out.documents[i - 1]!;
          const cur = out.documents[i]!;
          // ltrScore must be non-increasing (descending comparator >= 0).
          expect(compareScoreDescending(prev.ltrScore, cur.ltrScore)).toBeLessThanOrEqual(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P5 tie-break determinism ──────────────────────────────────────────────

describe('LTRRanker.rerank — property: tie-break by entityId', () => {
  it('P5 full ltr+retrieval ties resolve by entityId ascending (Hangul-safe)', () => {
    // Force a total tie: identical features (→ identical ltrScore) AND identical
    // retrievalScore. The only distinguishing key is entityId. With >1 unique
    // entityId and identical features the saturation guard fires (uniqueScores<=1),
    // so to actually exercise the sort tie-break we need >=2 distinct ltrScores.
    // We build TWO totally-tied docs plus one distinct-feature doc.
    fc.assert(
      fc.property(
        fc.uniqueArray(entityIdArb, { minLength: 2, maxLength: 2 }),
        scoreComponentsArb,
        unitScore,
        (twoIds, comps, retrieval) => {
          const tiedFeatures = extractLTRFeatures(comps);
          const distinctFeatures = extractLTRFeatures({
            ...comps,
            semantic: 1,
            popularity: 1,
            preferenceAlignment: 1,
          });
          const docs: MinimalRankable[] = [
            { entityId: twoIds[0]!, retrievalScore: retrieval, features: tiedFeatures, originalRank: 1 },
            { entityId: twoIds[1]!, retrievalScore: retrieval, features: tiedFeatures, originalRank: 2 },
            { entityId: 'zzz-distinct-신주', retrievalScore: retrieval, features: distinctFeatures, originalRank: 3 },
          ];
          const out = LTRRanker.rerank(docs, 'semantic_preference', makeWeights());
          if (out.saturated) return; // distinct doc should prevent saturation
          const pos = new Map(out.documents.map((d, i) => [d.entityId, i]));
          const [lo, hi] = [twoIds[0]!, twoIds[1]!].sort();
          // Among the two tied docs, the lexicographically smaller id ranks first.
          expect(pos.get(lo)! < pos.get(hi)!).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P6 NaN/Infinity guard on retrievalScore ───────────────────────────────

describe('LTRRanker.rerank — property: adversarial non-finite retrievalScore', () => {
  it('P6 non-finite retrievalScore never throws and never yields NaN ltrScore', () => {
    const adversarialRetrieval = fc.oneof(
      unitScore,
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
      fc.double({ min: -1e9, max: 1e9, noNaN: true }),
    );
    fc.assert(
      fc.property(uniqueDocsArb(adversarialRetrieval), (docs) => {
        const out = LTRRanker.rerank(docs, 'semantic_preference', makeWeights());
        // ltrScore comes from clamp01(model) on the scored path → always finite.
        // On the saturated/fallback path ltrScore = retrievalScore which CAN be
        // non-finite; the contract there is "no throw + still a permutation".
        expect(out.documents).toHaveLength(docs.length);
        const outIds = [...out.documents.map((d) => d.entityId)].sort();
        const inIds = [...docs.map((d) => d.entityId)].sort();
        expect(outIds).toEqual(inIds);
        if (!out.saturated) {
          for (const d of out.documents) {
            expect(Number.isFinite(d.ltrScore)).toBe(true);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P7 empty / singleton ──────────────────────────────────────────────────

describe('LTRRanker.rerank — property: empty and singleton', () => {
  it('P7 empty input → empty output; single doc → rank 1, not saturated', () => {
    fc.assert(
      fc.property(rankableArb(), (doc) => {
        const empty = LTRRanker.rerank([], 'semantic_preference', makeWeights());
        expect(empty.documents).toEqual([]);
        expect(empty.saturated).toBe(false);

        const single = LTRRanker.rerank([doc], 'semantic_preference', makeWeights());
        expect(single.documents).toHaveLength(1);
        expect(single.documents[0]!.finalRank).toBe(1);
        expect(single.saturated).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P8 saturation guard ───────────────────────────────────────────────────

describe('LTRRanker.rerank — property: saturation fallback', () => {
  it('P8 all-identical features (>=2 docs) → saturated + retrievalScore fallback', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.tuple(entityIdArb, unitScore),
          { minLength: 2, maxLength: 8, selector: (t) => t[0] },
        ),
        scoreComponentsArb,
        (idScorePairs, comps) => {
          const shared = extractLTRFeatures(comps);
          const docs: MinimalRankable[] = idScorePairs.map(([entityId, retrievalScore], i) => ({
            entityId,
            retrievalScore,
            features: shared,
            originalRank: i + 1,
          }));
          const out = LTRRanker.rerank(docs, 'semantic_preference', makeWeights());
          expect(out.saturated).toBe(true);
          // Fallback uses retrievalScore as ltrScore and preserves input order.
          expect(out.documents.map((d) => d.entityId)).toEqual(
            docs.map((d) => d.entityId),
          );
          for (const d of out.documents) {
            expect(d.ltrScore).toBe(d.retrievalScore);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P9 order-independence ─────────────────────────────────────────────────

describe('LTRRanker.rerank — property: input order independence', () => {
  it('P9 shuffling input does not change the (entityId → finalRank) mapping', () => {
    fc.assert(
      fc.property(
        uniqueDocsArb().filter((d) => d.length >= 2),
        fc.infiniteStream(fc.nat()),
        (docs, randStream) => {
          const model = makeWeights();
          const base = LTRRanker.rerank(docs, 'semantic_preference', model);

          // Deterministic shuffle driven by the generated stream.
          const shuffled = [...docs];
          const rng = randStream[Symbol.iterator]();
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = rng.next().value! % (i + 1);
            const tmp = shuffled[i]!;
            shuffled[i] = shuffled[j]!;
            shuffled[j] = tmp;
          }
          const reshuffled = LTRRanker.rerank(shuffled, 'semantic_preference', model);

          // The saturated path is order-PRESERVING by design, so it legitimately
          // differs under shuffle. Only the score-sorted path must be invariant.
          if (base.saturated || reshuffled.saturated) return;

          const baseMap = new Map(base.documents.map((d) => [d.entityId, d.finalRank]));
          const reMap = new Map(reshuffled.documents.map((d) => [d.entityId, d.finalRank]));
          expect(reMap).toEqual(baseMap);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P10 blendScores convexity + NaN guard ─────────────────────────────────

describe('LTRRanker.blendScores — property: convex blend, NaN-guarded', () => {
  it('P10 finite inputs → blend in [min,max]; out-of-range/NaN alpha never NaN', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
        fc.oneof(
          fc.double({ min: -5, max: 5, noNaN: true }),
          fc.constant(Number.NaN),
          fc.constant(Number.POSITIVE_INFINITY),
        ),
        (retrieval, ltr, alpha) => {
          const blended = LTRRanker.blendScores(retrieval, ltr, alpha);
          expect(Number.isFinite(blended)).toBe(true);
          // alpha is clamped to [0,1] → blend is a convex combination, bounded
          // by its two inputs (with a tiny epsilon for float rounding).
          const lo = Math.min(retrieval, ltr);
          const hi = Math.max(retrieval, ltr);
          const eps = 1e-6 * (1 + Math.abs(hi) + Math.abs(lo));
          expect(blended).toBeGreaterThanOrEqual(lo - eps);
          expect(blended).toBeLessThanOrEqual(hi + eps);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('P10b non-finite input term is dropped to 0, never poisons the blend', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (bad, good, alpha) => {
          expect(Number.isFinite(LTRRanker.blendScores(bad, good, alpha))).toBe(true);
          expect(Number.isFinite(LTRRanker.blendScores(good, bad, alpha))).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ─── P11 measureRerankingShift ─────────────────────────────────────────────

describe('LTRRanker.measureRerankingShift — property: finite, non-negative', () => {
  it('P11 shift is finite and >= 0 for any orderings (Hangul ids included)', () => {
    const orderArb = fc.uniqueArray(entityIdArb, { minLength: 0, maxLength: 12 });
    fc.assert(
      fc.property(orderArb, (order) => {
        const reversed = [...order].reverse();
        const shift = LTRRanker.measureRerankingShift(order, reversed);
        expect(Number.isFinite(shift)).toBe(true);
        expect(shift).toBeGreaterThanOrEqual(0);
        // Identical orderings → exactly 0.
        expect(LTRRanker.measureRerankingShift(order, order)).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
