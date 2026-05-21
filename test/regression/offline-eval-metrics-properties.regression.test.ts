/**
 * Regression: property-based IR-metric mathematical invariants for the offline
 * eval runner (`eval.offline-eval-runner`, SOTA++ maturity push 4→5).
 *
 * `scripts/eval/run-offline-eval.ts` aggregates per-query metrics from the pure
 * helpers in `scripts/eval/metrics.ts` (`ndcg`, `reciprocalRank`, `recall`,
 * `ece`). The release gate's verdict is only as trustworthy as those helpers.
 * This regression locks in the *proven* mathematical properties of the IR
 * metrics (Järvelin & Kekäläinen 2002 for NDCG; standard MRR / Recall / ECE)
 * — these are NOT heuristics: they are theorems about the metric definitions.
 *
 * Invariants locked (each at 100 fast-check runs):
 *   NDCG     — bounded in [0,1]; ideal ordering → 1.0; moving a strictly
 *              higher-relevance doc to the top never decreases NDCG@k
 *              (monotonicity); deterministic.
 *   MRR      — bounded in [0,1]; first-position relevant → 1.0; no relevant
 *              hit in top-k → 0; equals 1/(rank of first relevant).
 *   Recall@k — bounded in [0,1]; monotone non-decreasing in k; vacuously 1
 *              when there are no relevant docs.
 *   ECE      — bounded in [0,1] for any confidence/correctness configuration.
 *   Determinism — same input → identical metric (no float non-determinism).
 *
 * Touch-policy: regression-only, append-only. Imports the already-exported pure
 * functions from `scripts/eval/metrics.ts`; no source change required.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ndcg,
  reciprocalRank,
  recall,
  ece,
  type RankedHit,
  type RelevanceMap,
  type DecisionOutcome,
  type GroundTruth,
} from '../../scripts/eval/metrics.js';

const NUM_RUNS = 100;
// Float comparison tolerance — IR metric arithmetic (log2 discounts, ratios)
// accumulates IEEE-754 rounding well under this bound for the sizes tested.
const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Distinct entity ids so a ranked list never accidentally double-counts. */
function entityIdArb(): fc.Arbitrary<string> {
  return fc.integer({ min: 0, max: 200 }).map((n) => `e${n}`);
}

/** Graded relevance: integer grades 0..3 (standard graded-relevance scale). */
function gradeArb(): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: 3 });
}

/** A relevance map (entity_id → grade). */
function relevanceMapArb(): fc.Arbitrary<RelevanceMap> {
  return fc
    .uniqueArray(fc.tuple(entityIdArb(), gradeArb()), {
      maxLength: 12,
      selector: ([id]) => id,
    })
    .map((entries) => ({ judgments: new Map(entries) }));
}

/** A ranked hit list with distinct entity ids and finite scores. */
function rankedArb(): fc.Arbitrary<RankedHit[]> {
  return fc
    .uniqueArray(entityIdArb(), { maxLength: 15 })
    .chain((ids) =>
      fc.tuple(
        ...ids.map((id) =>
          fc
            .float({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true })
            .map((score): RankedHit => ({ entity_id: id, score })),
        ),
      ),
    )
    .map((hits) => [...hits]);
}

/** k in a realistic eval cutoff range, including 0 and beyond list length. */
function kArb(): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: 20 });
}

// ---------------------------------------------------------------------------
// NDCG invariants (Järvelin & Kekäläinen 2002)
// ---------------------------------------------------------------------------

describe('NDCG@k mathematical invariants', () => {
  it('is bounded in [0, 1] for any ranking and relevance vector', () => {
    fc.assert(
      fc.property(rankedArb(), relevanceMapArb(), kArb(), (ranked, rel, k) => {
        const v = ndcg(ranked, rel, k);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0 - EPSILON);
        expect(v).toBeLessThanOrEqual(1 + EPSILON);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns 1.0 for the ideal ordering (relevant docs sorted by grade desc)', () => {
    fc.assert(
      fc.property(relevanceMapArb(), kArb(), (rel, k) => {
        // Build the ideal ranking: all judged ids sorted by grade descending.
        const idealOrder = [...rel.judgments.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id]): RankedHit => ({ entity_id: id, score: 0 }));
        const v = ndcg(idealOrder, rel, k);
        const hasGradedDoc = [...rel.judgments.values()].some((g) => g > 0);
        if (hasGradedDoc && k > 0) {
          expect(v).toBeCloseTo(1.0, 9);
        } else {
          // No positive grade (or k=0) → ideal DCG is 0 → metric defined as 0.
          expect(v).toBe(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('never decreases when a strictly higher-grade doc is swapped to the top', () => {
    fc.assert(
      fc.property(
        rankedArb().filter((r) => r.length >= 2),
        relevanceMapArb(),
        fc.integer({ min: 1, max: 14 }),
        (ranked, rel, j) => {
          const k = ranked.length;
          const idx = Math.min(j, ranked.length - 1);
          const grade = (id: string): number => rel.judgments.get(id) ?? 0;
          const before = ndcg(ranked, rel, k);
          // Swap position idx to the front only if it is strictly more relevant
          // than the current head; otherwise the invariant does not apply.
          const head = ranked[0]!;
          const cand = ranked[idx]!;
          if (grade(cand) <= grade(head)) return; // precondition not met
          const swapped = [...ranked];
          swapped[0] = cand;
          swapped[idx] = head;
          const after = ndcg(swapped, rel, k);
          expect(after).toBeGreaterThanOrEqual(before - EPSILON);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic: same input → identical output', () => {
    fc.assert(
      fc.property(rankedArb(), relevanceMapArb(), kArb(), (ranked, rel, k) => {
        expect(ndcg(ranked, rel, k)).toBe(ndcg(ranked, rel, k));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// MRR invariants
// ---------------------------------------------------------------------------

describe('MRR (reciprocal rank) mathematical invariants', () => {
  it('is bounded in [0, 1]', () => {
    fc.assert(
      fc.property(rankedArb(), relevanceMapArb(), kArb(), (ranked, rel, k) => {
        const v = reciprocalRank(ranked, rel, k);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('equals 1/(1-based rank of first relevant hit) and 1.0 when first hit is relevant', () => {
    fc.assert(
      fc.property(
        rankedArb().filter((r) => r.length >= 1),
        relevanceMapArb(),
        (ranked, rel) => {
          const k = ranked.length;
          const v = reciprocalRank(ranked, rel, k);
          // Find the first relevant (grade >= 1) position manually.
          let firstRelevant = -1;
          for (let i = 0; i < ranked.length; i++) {
            if ((rel.judgments.get(ranked[i]!.entity_id) ?? 0) >= 1) {
              firstRelevant = i;
              break;
            }
          }
          if (firstRelevant === -1) {
            expect(v).toBe(0);
          } else {
            expect(v).toBeCloseTo(1 / (firstRelevant + 1), 9);
            if (firstRelevant === 0) expect(v).toBe(1);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns 0 when no relevant hit exists within top-k', () => {
    fc.assert(
      fc.property(rankedArb(), kArb(), (ranked, k) => {
        // Empty relevance map → nothing is relevant → MRR must be 0.
        const empty: RelevanceMap = { judgments: new Map() };
        expect(reciprocalRank(ranked, empty, k)).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Recall@k invariants
// ---------------------------------------------------------------------------

describe('Recall@k mathematical invariants', () => {
  it('is bounded in [0, 1]', () => {
    fc.assert(
      fc.property(rankedArb(), relevanceMapArb(), kArb(), (ranked, rel, k) => {
        const v = recall(ranked, rel, k);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is monotone non-decreasing in k', () => {
    fc.assert(
      fc.property(
        rankedArb(),
        relevanceMapArb(),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (ranked, rel, a, b) => {
          const kLow = Math.min(a, b);
          const kHigh = Math.max(a, b);
          const low = recall(ranked, rel, kLow);
          const high = recall(ranked, rel, kHigh);
          expect(high).toBeGreaterThanOrEqual(low - EPSILON);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('is vacuously 1 when there are no relevant documents', () => {
    fc.assert(
      fc.property(rankedArb(), kArb(), (ranked, k) => {
        const empty: RelevanceMap = { judgments: new Map() };
        expect(recall(ranked, empty, k)).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// ECE invariants
// ---------------------------------------------------------------------------

/** A decision outcome with a confidence probability in [0,1]. */
function outcomeArb(): fc.Arbitrary<DecisionOutcome> {
  return fc.record({
    decision_status: fc.constantFrom('resolved', 'ambiguous', 'failed'),
    top_entity_id: fc.option(entityIdArb(), { nil: null }),
    decision_confidence: fc.float({
      min: 0,
      max: 1,
      noNaN: true,
      noDefaultInfinity: true,
    }),
  });
}

/** A ground truth pairing an expected entity id and a relevance map. */
function truthArb(): fc.Arbitrary<GroundTruth> {
  return fc.record({
    expected_status: fc.constantFrom('resolved', 'ambiguous', 'failed'),
    expected_entity_id: entityIdArb(),
    ambiguity_expected: fc.boolean(),
    requires_abstain: fc.boolean(),
    relevant: relevanceMapArb(),
  });
}

describe('ECE (expected calibration error) mathematical invariants', () => {
  it('is bounded in [0, 1] for any confidence/correctness configuration', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(outcomeArb(), truthArb()), { maxLength: 60 }),
        fc.integer({ min: 1, max: 20 }),
        (pairs, bins) => {
          const outcomes = pairs.map(([o]) => o);
          const truths = pairs.map(([, t]) => t);
          const v = ece(outcomes, truths, bins);
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0 - EPSILON);
          expect(v).toBeLessThanOrEqual(1 + EPSILON);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic: same input → identical output', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(outcomeArb(), truthArb()), { maxLength: 60 }),
        (pairs) => {
          const outcomes = pairs.map(([o]) => o);
          const truths = pairs.map(([, t]) => t);
          expect(ece(outcomes, truths)).toBe(ece(outcomes, truths));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
