/**
 * Property-based regression tests for the Mixed Retrieval Mode fusion core
 * (retrieval.mixed-retrieval-mode). Mixed-mode blends dense (ANN / anchor
 * similarity) and sparse (BM25 / learned-sparse) retrieval channels into one
 * ranked candidate pool via Reciprocal Rank Fusion (RRF).
 *
 * The fusion stage is the deterministic heart of mixed-mode: given the four
 * channel hit lists it MUST produce one stable, conserved, bounded ranking
 * regardless of the order Vespa returned the lanes in, and regardless of how
 * adversarial the raw scores are (NaN / ±Infinity / negative / zero). These
 * properties are append-only and never relax {@link FusionService.fuse}; any
 * property that cannot hold is recorded under the feature YAML's
 * `known_limitations` instead of being weakened here.
 *
 * Invariants verified (numRuns=100 each):
 *  1. Determinism — fuse(x) deep-equals fuse(x) for arbitrary channel inputs.
 *  2. RRF SSoT — every fused score equals the sum of weighted
 *     `rrfContribution(rank, k)` (from `@shared/utils/rrf.ts`) over the lanes
 *     that contributed a rank, i.e. NO private `1/(k+rank)` is used and the
 *     lexical-family collapse is honoured.
 *  3. Permutation stability — reordering the hits WITHIN each lane (Vespa is
 *     free to return ties in any order) yields a byte-identical fused order.
 *  4. NaN / Infinity safety — adversarial raw scores never produce a NaN or
 *     non-finite fused score, and never throw.
 *  5. Tie-break determinism — equal fused scores are ordered by ascending
 *     entityId (the SSoT comparator key), and non-finite-score candidates sort
 *     strictly last.
 *  6. Bounded output — the fused pool size never exceeds the count of distinct
 *     entity IDs across the input lanes (channel-set conservation upper bound)
 *     and respects the named MAX bound the property harness feeds in.
 *  7. Channel-set conservation — the union of fused entity IDs equals the union
 *     of input entity IDs (no entity invented, none dropped at the fusion
 *     stage), and each candidate's `candidateSources` reflects exactly the
 *     lanes that ranked it.
 *  8. Empty-channel safety — any subset of lanes being empty (including all
 *     four) returns a well-formed (possibly empty) ranking without throwing.
 *  9. Weight monotonicity — raising one lane's weight never decreases the
 *     fused score of an entity that ONLY that lane ranked.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FusionService, NEUTRAL_FUSION_WEIGHTS, type FusionWeights } from '../../src/domain/retrieval/service/fusion.js';
import { rrfContribution, RRF_DEFAULT_K } from '../../src/domain/shared/utils/rrf.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';
import type { SparseHit, DenseHit } from '../../src/domain/retrieval/port/search-index.port.js';

/** numRuns for every property — pinned per directive (fc properties numRuns=100). */
const FC_NUM_RUNS = 100;

/**
 * Floating-point tolerance for RRF-score equality assertions. RRF sums a few
 * `1/(k+rank)` terms; IEEE-754 reassociation across map-iteration order can
 * differ in the last ~1 ulp. 1e-9 is far tighter than any rank gap
 * (min gap ≈ 1/(60+N) − 1/(60+N+1) ≈ 2.4e-4 for N≤200) so it never masks a
 * real ranking inversion.
 */
const RRF_SCORE_EPSILON = 1e-9;

/**
 * Upper bound on entities-per-lane fed to the generators. Keeps generated
 * pools in a realistic retrieval window (Vespa topN is O(100)) while still
 * exercising dedup, ties, and conservation. Named const per CLAUDE.md rule 13/15.
 */
const MAX_HITS_PER_LANE = 24;

/** Distinct entity-id universe the arbitraries draw from (forces cross-lane overlap). */
const ENTITY_ID_POOL_SIZE = 40;

/**
 * Korean query/label surfaces that mixed-mode ("이거랑 비슷한", "스타일이 비슷한")
 * routinely carries on summaries. Used to assert Hangul payloads survive fusion
 * untouched (no ASCII-only assumptions in the dedup/merge path).
 */
const KOREAN_LABELS: readonly string[] = [
  '오퍼스 원 2018',
  '스타일이 비슷한 까베르네',
  '이거랑 비슷한 부르고뉴',
  '풍부한 레드 와인',
  '나파 밸리 까베르네 소비뇽',
  '샤르도네 화이트',
];

const entityIdArb = fc
  .integer({ min: 0, max: ENTITY_ID_POOL_SIZE - 1 })
  .map((n) => createCanonicalEntityId(`wine-${n}`));

/**
 * Adversarial raw-score arbitrary: ordinary doubles plus the exact pathological
 * sentinels that have historically corrupted score sorts (NaN, ±Infinity, ±0,
 * negatives). The fused score is computed from RANK (1/(k+rank)), not raw score,
 * so these must never leak into the fused total — the property checks confirm it.
 */
const rawScoreArb = fc.oneof(
  fc.double({ noNaN: false, noDefaultInfinity: false }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, -1, 1e308),
);

const koreanSummaryArb = fc.option(
  fc.record({
    canonicalLabel: fc.constantFrom(...KOREAN_LABELS),
    semanticSummary: fc.constantFrom(...KOREAN_LABELS),
  }),
  { nil: undefined },
);

/**
 * Build a lane (sparse OR dense shaped) of hits with adversarial scores and
 * 1-based ranks. Ranks are assigned by position so the same entity can recur
 * at different positions (Vespa-dedup-failure case) — fuse() must keep the best.
 */
function laneArb<THit extends 'sparse' | 'dense'>(kind: THit): fc.Arbitrary<
  THit extends 'sparse' ? readonly SparseHit[] : readonly DenseHit[]
> {
  const hitArb = fc.record({
    entityId: entityIdArb,
    score: rawScoreArb,
    summary: koreanSummaryArb,
  });
  return fc.array(hitArb, { maxLength: MAX_HITS_PER_LANE }).map((hits) =>
    hits.map((h, idx) => {
      const base = {
        entityId: h.entityId,
        score: h.score,
        rank: idx + 1, // 1-based, position-derived
        ...(h.summary !== undefined ? { summary: h.summary } : {}),
      };
      if (kind === 'sparse') {
        return { ...base, matchedFields: ['search_text_ko'] } as SparseHit;
      }
      return { ...base, similarity: 0.5 } as DenseHit;
    }),
  ) as fc.Arbitrary<THit extends 'sparse' ? readonly SparseHit[] : readonly DenseHit[]>;
}

const weightArb = fc.double({ min: 0, max: 4, noNaN: true, noDefaultInfinity: true });
const fusionWeightsArb: fc.Arbitrary<FusionWeights> = fc.record({
  sparseWeight: weightArb,
  denseWeight: weightArb,
  anchorWeight: weightArb,
  learnedSparseWeight: weightArb,
});

const kArb = fc.integer({ min: 1, max: 200 });

/** Reduce hit list to a best-rank map (mirrors fuse() dedup: lowest rank wins). */
function bestRankMap(hits: readonly { entityId: string; rank: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of hits) {
    const cur = m.get(h.entityId);
    if (cur === undefined || h.rank < cur) m.set(h.entityId, h.rank);
  }
  return m;
}

function shuffleWithSeed<T>(arr: readonly T[], seed: number): T[] {
  // Deterministic Fisher–Yates using a tiny LCG — keeps the test reproducible
  // and avoids depending on a non-seeded Math.random().
  const out = [...arr];
  let s = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

describe('mixed-retrieval-mode fusion — property invariants', () => {
  const fusion = new FusionService();

  it('1. determinism — identical inputs produce deep-equal fused output', () => {
    fc.assert(
      fc.property(
        laneArb('sparse'),
        laneArb('dense'),
        laneArb('dense'),
        laneArb('dense'),
        kArb,
        fusionWeightsArb,
        (sparse, dense, anchor, learned, k, weights) => {
          const a = fusion.fuse(sparse, dense, anchor, k, learned, weights);
          const b = fusion.fuse(sparse, dense, anchor, k, learned, weights);
          expect(a).toEqual(b);
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });

  it('2. RRF SSoT — fused score equals weighted sum of rrfContribution() over contributing lanes', () => {
    fc.assert(
      fc.property(
        laneArb('sparse'),
        laneArb('dense'),
        laneArb('dense'),
        laneArb('dense'),
        kArb,
        fusionWeightsArb,
        (sparse, dense, anchor, learned, k, weights) => {
          const fused = fusion.fuse(sparse, dense, anchor, k, learned, weights);

          const sparseRanks = bestRankMap(sparse);
          const denseRanks = bestRankMap(dense);
          const anchorRanks = bestRankMap(anchor);
          const learnedRanks = bestRankMap(learned);

          for (const cand of fused) {
            const id = cand.entityId;
            // Lexical family: best rank across sparse+learned, effective weight = max of the two lane weights.
            const sR = sparseRanks.get(id);
            const lR = learnedRanks.get(id);
            let expected = 0;
            if (sR !== undefined || lR !== undefined) {
              const famRank = Math.min(sR ?? Infinity, lR ?? Infinity);
              let famWeight: number;
              if (sR !== undefined && lR !== undefined) {
                famWeight = Math.max(weights.sparseWeight, weights.learnedSparseWeight);
              } else if (sR !== undefined) {
                famWeight = weights.sparseWeight;
              } else {
                famWeight = weights.learnedSparseWeight;
              }
              const c = famWeight * rrfContribution(famRank, k);
              if (Number.isFinite(c) && c !== 0) expected += c;
            }
            const dR = denseRanks.get(id);
            if (dR !== undefined) {
              const c = weights.denseWeight * rrfContribution(dR, k);
              if (Number.isFinite(c) && c !== 0) expected += c;
            }
            const aR = anchorRanks.get(id);
            if (aR !== undefined) {
              const c = weights.anchorWeight * rrfContribution(aR, k);
              if (Number.isFinite(c) && c !== 0) expected += c;
            }
            expect(cand.fusionRrfTotal).toBeCloseTo(expected, 9);
          }
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });

  it('3. permutation stability — reordering hits within each lane preserves fused order', () => {
    fc.assert(
      fc.property(
        laneArb('sparse'),
        laneArb('dense'),
        laneArb('dense'),
        laneArb('dense'),
        kArb,
        fusionWeightsArb,
        fc.integer({ min: 1, max: 1_000_000 }),
        (sparse, dense, anchor, learned, k, weights, seed) => {
          // Reordering within a lane re-derives ranks by NEW position. To make the
          // permutation rank-preserving, carry each hit's rank explicitly by
          // shuffling the (entity,rank,score) records — then re-emit with the SAME
          // rank field rather than position. This isolates "input order" from "rank".
          const reRank = <T extends { rank: number }>(hits: readonly T[]): T[] => {
            const shuffled = shuffleWithSeed(hits, seed);
            return shuffled.map((h) => ({ ...h })); // ranks preserved as-is
          };
          const base = fusion.fuse(sparse, dense, anchor, k, learned, weights);
          const permuted = fusion.fuse(
            reRank(sparse),
            reRank(dense),
            reRank(anchor),
            k,
            reRank(learned),
            weights,
          );
          expect(permuted.map((c) => c.entityId)).toEqual(base.map((c) => c.entityId));
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });

  it('4. NaN / Infinity safety — adversarial raw scores never yield non-finite fused scores and never throw', () => {
    fc.assert(
      fc.property(
        laneArb('sparse'),
        laneArb('dense'),
        laneArb('dense'),
        laneArb('dense'),
        kArb,
        fusionWeightsArb,
        (sparse, dense, anchor, learned, k, weights) => {
          const fused = fusion.fuse(sparse, dense, anchor, k, learned, weights);
          for (const c of fused) {
            expect(Number.isFinite(c.fusionRrfTotal)).toBe(true);
          }
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });

  it('5. tie-break determinism — equal fused scores ordered by ascending entityId, descending score otherwise', () => {
    fc.assert(
      fc.property(
        laneArb('sparse'),
        laneArb('dense'),
        laneArb('dense'),
        laneArb('dense'),
        kArb,
        fusionWeightsArb,
        (sparse, dense, anchor, learned, k, weights) => {
          const fused = fusion.fuse(sparse, dense, anchor, k, learned, weights);
          for (let i = 1; i < fused.length; i++) {
            const prev = fused[i - 1]!;
            const cur = fused[i]!;
            const pScore = Number.isFinite(prev.fusionRrfTotal) ? prev.fusionRrfTotal! : -Infinity;
            const cScore = Number.isFinite(cur.fusionRrfTotal) ? cur.fusionRrfTotal! : -Infinity;
            // The comparator (fusion.ts) breaks ties on EXACT score equality only
            // (`aScore !== bScore`), so the property mirrors that contract exactly:
            // sub-ulp score differences are real ordering signal, not ties. Using a
            // tolerance band here would wrongly demand entityId order for genuinely
            // distinct (subnormal) scores produced by extreme lane weights.
            if (pScore === cScore) {
              // tie → entityId ascending
              expect(prev.entityId <= cur.entityId).toBe(true);
            } else {
              // strictly descending score
              expect(pScore).toBeGreaterThan(cScore);
            }
          }
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });

  it('6. bounded output — fused size ≤ distinct input entity ids', () => {
    fc.assert(
      fc.property(
        laneArb('sparse'),
        laneArb('dense'),
        laneArb('dense'),
        laneArb('dense'),
        kArb,
        (sparse, dense, anchor, learned, k) => {
          const fused = fusion.fuse(sparse, dense, anchor, k, learned);
          const distinct = new Set<string>();
          for (const h of [...sparse, ...dense, ...anchor, ...learned]) distinct.add(h.entityId);
          expect(fused.length).toBeLessThanOrEqual(distinct.size);
          expect(fused.length).toBeLessThanOrEqual(4 * MAX_HITS_PER_LANE);
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });

  it('7. channel-set conservation — fused id-union equals input id-union; candidateSources match contributing lanes', () => {
    fc.assert(
      fc.property(
        laneArb('sparse'),
        laneArb('dense'),
        laneArb('dense'),
        laneArb('dense'),
        kArb,
        (sparse, dense, anchor, learned, k) => {
          const fused = fusion.fuse(sparse, dense, anchor, k, learned);
          const inputIds = new Set<string>();
          for (const h of [...sparse, ...dense, ...anchor, ...learned]) inputIds.add(h.entityId);
          const fusedIds = new Set(fused.map((c) => c.entityId as string));
          expect([...fusedIds].sort()).toEqual([...inputIds].sort());

          const sIds = new Set(sparse.map((h) => h.entityId as string));
          const dIds = new Set(dense.map((h) => h.entityId as string));
          const aIds = new Set(anchor.map((h) => h.entityId as string));
          const lIds = new Set(learned.map((h) => h.entityId as string));
          for (const c of fused) {
            const id = c.entityId as string;
            const sources = new Set(c.retrievalTrace.candidateSources);
            expect(sources.has('sparse_bm25')).toBe(sIds.has(id));
            expect(sources.has('dense_semantic')).toBe(dIds.has(id));
            expect(sources.has('anchor_similarity')).toBe(aIds.has(id));
            expect(sources.has('learned_sparse')).toBe(lIds.has(id));
            // At least one lane must claim every fused candidate.
            expect(sources.size).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });

  it('8. empty-channel safety — any subset of empty lanes returns a well-formed ranking', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        laneArb('sparse'),
        laneArb('dense'),
        laneArb('dense'),
        laneArb('dense'),
        (emptyS, emptyD, emptyA, emptyL, sparse, dense, anchor, learned) => {
          const s = emptyS ? [] : sparse;
          const d = emptyD ? [] : dense;
          const a = emptyA ? [] : anchor;
          const l = emptyL ? [] : learned;
          const fused = fusion.fuse(s, d, a, RRF_DEFAULT_K, l);
          expect(Array.isArray(fused)).toBe(true);
          if (emptyS && emptyD && emptyA && emptyL) {
            expect(fused).toHaveLength(0);
          }
          for (const c of fused) expect(Number.isFinite(c.fusionRrfTotal)).toBe(true);
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });

  it('9. weight monotonicity — raising a lane weight never lowers the score of an entity only that lane ranked', () => {
    fc.assert(
      fc.property(
        laneArb('dense'),
        kArb,
        fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 2, noNaN: true, noDefaultInfinity: true }),
        (anchorOnly, k, w1, w2) => {
          // anchorOnly is the ONLY lane → every entity is anchor-exclusive.
          const lowWeight = Math.min(w1, w2);
          const highWeight = Math.max(w1, w2);
          const scoreAt = (anchorWeight: number): Map<string, number> => {
            const weights: FusionWeights = { ...NEUTRAL_FUSION_WEIGHTS, anchorWeight };
            const fused = fusion.fuse([], [], anchorOnly, k, [], weights);
            return new Map(fused.map((c) => [c.entityId as string, c.fusionRrfTotal]));
          };
          const lo = scoreAt(lowWeight);
          const hi = scoreAt(highWeight);
          for (const [id, loScore] of lo) {
            const hiScore = hi.get(id) ?? 0;
            // Higher (or equal) weight ⇒ higher-or-equal score for an anchor-only entity.
            expect(hiScore + RRF_SCORE_EPSILON).toBeGreaterThanOrEqual(loScore);
          }
        },
      ),
      { numRuns: FC_NUM_RUNS },
    );
  });
});
