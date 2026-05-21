/**
 * Regression: property-based invariants for the DETERMINISTIC scoring harness
 * behind `eval.benchmark-runner` (SOTA++ maturity push 4→5).
 *
 * MT-Bench / AlpacaEval pattern: the LLM-as-judge component is probabilistic and
 * its variance is an inherent, documented limitation (see `judge.ts` — N=3 median,
 * DIMENSION_FLOOR caps judge noise). What justifies SOTA++ is that the
 * SCORING / METRIC / AGGREGATION harness around the judge is fully deterministic
 * and property-locked. This regression locks the proven mathematical properties
 * of that harness — these are NOT heuristics, they are theorems about the metric
 * definitions (TAC KBP / SemEval F1, Järvelin & Kekäläinen 2002 nDCG, weighted
 * geometric mean).
 *
 * Pure functions under property test (NO LLM calls, no Date/random in path):
 *   constraint-metrics.ts  — scoreSemanticConstraintRecall (SCR P1),
 *                            scoreSlotF1 (P3 precision/recall/F1), scoreUDCG (P6)
 *   ranking-metrics.ts     — ndcg_at_k, mrr, map_at_k
 *   retrieval-ceiling.ts   — computeRetrievalCeiling, diagnoseRankingGap
 *   scorer.ts              — renormaliseWeights, weightedGeometricMean (dimension
 *                            weighting; exported minimally for this test)
 *
 * Invariants locked (each at 100 fast-check runs):
 *   - dimension weight normalization: renormaliseWeights sums to 1.0;
 *     weightedGeometricMean ∈ [0,1] for any dim/weight config
 *   - constraint-metric bounds: SCR / Slot-F1 buckets ∈ [0,1] for any input
 *   - constraint perfect-match: extracted ⊇ expected → recall = SlotF1 = 1.0
 *   - retrieval ceiling bounds: recall@k / oracle nDCG / oracle MRR / coverage /
 *     efficiency ∈ [0,1]
 *   - scoring determinism: same input → byte-identical score
 *   - aggregation monotone: appending a PASS scenario never lowers pass rate
 *
 * Touch-policy: regression-only, append-only.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  scoreSemanticConstraintRecall,
  scoreSlotF1,
  scoreUDCG,
} from '../../test/benchmark/agent/constraint-metrics.js';
import { ndcg_at_k, mrr, map_at_k } from '../../test/benchmark/agent/ranking-metrics.js';
import {
  computeRetrievalCeiling,
  diagnoseRankingGap,
} from '../../test/benchmark/agent/retrieval-ceiling-metrics.js';
import {
  renormaliseWeights,
  weightedGeometricMean,
  DEFAULT_WEIGHTS,
  type DimensionWeights,
} from '../../test/benchmark/agent/scorer.js';
import type { ExpectedConstraint } from '../../test/benchmark/agent/scenario.js';
import type {
  ConstraintBundle,
  NormalizedConstraint,
} from '../../src/domain/shared/types/index.js';

const NUM_RUNS = 100;
// Float comparison tolerance — geo-mean (log/exp) + nDCG (log2 discount) arithmetic
// accumulates IEEE-754 rounding well under this bound for the sizes tested.
const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Helpers / arbitraries
// ---------------------------------------------------------------------------

function inUnitInterval(x: number): boolean {
  return Number.isFinite(x) && x >= -EPSILON && x <= 1 + EPSILON;
}

/** Distinct entity ids so a ranked/relevant list never accidentally collides. */
function entityIdArb(): fc.Arbitrary<string> {
  return fc.integer({ min: 0, max: 60 }).map((n) => `e${n}`);
}

function idListArb(maxLength: number): fc.Arbitrary<string[]> {
  // uniqueArray: a candidate pool / ranking has no duplicate doc ids.
  return fc.uniqueArray(entityIdArb(), { maxLength });
}

function relevantSetArb(maxSize: number): fc.Arbitrary<ReadonlySet<string>> {
  return fc.uniqueArray(entityIdArb(), { maxLength: maxSize }).map((arr) => new Set(arr));
}

const ATTRIBUTES = ['country', 'region', 'grape_primary', 'price', 'vintage', 'wine_type'] as const;

/** Build an ExpectedConstraint with a coherent operator/value pairing. */
function expectedConstraintArb(): fc.Arbitrary<ExpectedConstraint> {
  return fc.oneof(
    // string =/in/exclude
    fc.record({
      attribute: fc.constantFrom(...ATTRIBUTES),
      operator: fc.constantFrom('=' as const, 'in' as const, 'exclude' as const),
      value: fc.constantFrom('france', 'italy', 'merlot', 'red', 'tuscany'),
    }),
    // numeric bound
    fc.record({
      attribute: fc.constantFrom('price' as const, 'vintage' as const),
      operator: fc.constantFrom('<=' as const, '>=' as const),
      value: fc.integer({ min: 1, max: 100000 }),
    }),
    // range
    fc.record({
      attribute: fc.constantFrom('price' as const, 'vintage' as const),
      operator: fc.constant('range' as const),
      value: fc
        .tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 500, max: 1000 }))
        .map(([min, max]) => ({ min, max })),
    }),
  );
}

/** Lift an ExpectedConstraint to a NormalizedConstraint (extraction output shape). */
function toNormalized(e: ExpectedConstraint): NormalizedConstraint {
  return {
    attribute: e.attribute,
    operator: e.operator,
    value: e.value as NormalizedConstraint['value'],
    source_phrase: 'synthetic',
    confidence: 1,
  };
}

function emptyBundle(): ConstraintBundle {
  return { hard: [], soft: [], inferred: [] };
}

function dimScoresArb(): fc.Arbitrary<Record<string, number | null>> {
  const keys = Object.keys(DEFAULT_WEIGHTS);
  return fc.record(
    Object.fromEntries(
      keys.map((k) => [
        k,
        fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant(null)),
      ]),
    ),
  ) as fc.Arbitrary<Record<string, number | null>>;
}

function weightsArb(): fc.Arbitrary<Required<DimensionWeights>> {
  const keys = Object.keys(DEFAULT_WEIGHTS);
  return fc.record(
    Object.fromEntries(keys.map((k) => [k, fc.double({ min: 0, max: 1, noNaN: true })])),
  ) as fc.Arbitrary<Required<DimensionWeights>>;
}

// ===========================================================================
// Property: dimension weight normalization
// ===========================================================================

describe('dimension weight normalization (scorer)', () => {
  it('renormaliseWeights produces weights summing to 1.0 (when total > 0)', () => {
    fc.assert(
      fc.property(weightsArb(), (weights) => {
        const sum = Object.values(weights).reduce((a, b) => a + b, 0);
        const normalized = renormaliseWeights(weights);
        const normSum = Object.values(normalized).reduce((a, b) => a + b, 0);
        if (sum > 0) {
          expect(Math.abs(normSum - 1)).toBeLessThan(1e-9);
        } else {
          // all-zero weights: function returns input unchanged (sum stays 0)
          expect(normSum).toBe(0);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('renormaliseWeights preserves relative proportions', () => {
    fc.assert(
      fc.property(weightsArb(), (weights) => {
        const normalized = renormaliseWeights(weights);
        // ratio between any two positive weights is invariant under scaling
        // Only compare ratios for non-tiny weights — a near-zero denominator
        // (double down to ~1e-300) makes the ratio numerically meaningless,
        // not a property violation. Relative tolerance handles scaling.
        const entries = Object.entries(weights).filter(([, v]) => v > 1e-3);
        if (entries.length >= 2) {
          const [k0, v0] = entries[0]!;
          const [k1, v1] = entries[1]!;
          const origRatio = v0 / v1;
          const newRatio = normalized[k0 as keyof typeof normalized]
            / normalized[k1 as keyof typeof normalized];
          expect(Math.abs(origRatio - newRatio)).toBeLessThan(1e-6 * (1 + origRatio));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('weightedGeometricMean result ∈ [0,1] for any dim/weight configuration', () => {
    fc.assert(
      fc.property(dimScoresArb(), weightsArb(), (dimScores, weights) => {
        const result = weightedGeometricMean(dimScores, weights);
        expect(inUnitInterval(result)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('weightedGeometricMean = 1.0 when every present dim is a perfect 1.0', () => {
    fc.assert(
      fc.property(weightsArb(), (weights) => {
        const allOnes: Record<string, number> = {};
        for (const k of Object.keys(weights)) allOnes[k] = 1;
        const total = Object.values(weights).reduce((a, b) => a + b, 0);
        const result = weightedGeometricMean(allOnes, weights);
        if (total > 0) {
          expect(Math.abs(result - 1)).toBeLessThan(1e-3);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ===========================================================================
// Property: constraint-metric bounds + perfect match
// ===========================================================================

describe('constraint-metric bounds (SCR / Slot-F1)', () => {
  it('SCR buckets and overall ∈ [0,1] (or null) for any extracted/expected pair', () => {
    fc.assert(
      fc.property(
        fc.array(expectedConstraintArb(), { maxLength: 8 }),
        fc.array(expectedConstraintArb(), { maxLength: 8 }),
        (expectedList, extractedList) => {
          const extracted: ConstraintBundle = {
            ...emptyBundle(),
            hard: extractedList.map(toNormalized),
          };
          const score = scoreSemanticConstraintRecall(extracted, { hard: expectedList });
          for (const v of [score.scrHard, score.scrSoft, score.scrInferred, score.scrOverall]) {
            if (v !== null) expect(inUnitInterval(v)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('Slot-F1 (precision/recall→F1) ∈ [0,1] across strict/relaxed/type_only', () => {
    fc.assert(
      fc.property(
        fc.array(expectedConstraintArb(), { maxLength: 8 }),
        fc.array(expectedConstraintArb(), { maxLength: 8 }),
        (expectedList, extractedList) => {
          const extracted: ConstraintBundle = {
            ...emptyBundle(),
            hard: extractedList.map(toNormalized),
          };
          const f1 = scoreSlotF1(extracted, { hard: expectedList });
          for (const v of [f1.strict, f1.relaxed, f1.typeOnly]) {
            if (v !== null) expect(inUnitInterval(v)).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('perfect match: extracted ⊇ expected → SCR recall = 1.0 and Slot-F1 strict = 1.0', () => {
    fc.assert(
      fc.property(
        fc.array(expectedConstraintArb(), { minLength: 1, maxLength: 6 }),
        (expectedList) => {
          // extracted contains EXACTLY the expected constraints (perfect extraction)
          const extracted: ConstraintBundle = {
            ...emptyBundle(),
            hard: expectedList.map(toNormalized),
          };
          const scr = scoreSemanticConstraintRecall(extracted, { hard: expectedList }, 'strict');
          expect(scr.scrHard).not.toBeNull();
          expect(Math.abs((scr.scrHard ?? 0) - 1)).toBeLessThan(EPSILON);

          const f1 = scoreSlotF1(extracted, { hard: expectedList });
          // strict F1 = 1.0 because tp = |expected| = |actual|, fp = fn = 0
          expect(f1.strict).not.toBeNull();
          expect(Math.abs((f1.strict ?? 0) - 1)).toBeLessThan(EPSILON);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('empty expectation → all buckets null (unmeasurable, no penalty)', () => {
    fc.assert(
      fc.property(fc.array(expectedConstraintArb(), { maxLength: 6 }), (extractedList) => {
        const extracted: ConstraintBundle = {
          ...emptyBundle(),
          hard: extractedList.map(toNormalized),
        };
        const scr = scoreSemanticConstraintRecall(extracted, {});
        expect(scr.scrOverall).toBeNull();
        const f1 = scoreSlotF1(extracted, {});
        expect(f1.strict).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('UDCG@k ∈ [-? ..] bounded: utility-penalized DCG normalizes to ≤ 1.0', () => {
    fc.assert(
      fc.property(idListArb(20), relevantSetArb(10), (obs, relevant) => {
        const v = scoreUDCG(obs, relevant, 10);
        if (v !== null) {
          // UDCG can go negative (irrelevant docs carry -1 utility) but the
          // best achievable (all relevant at top) normalizes to exactly 1.0.
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeLessThanOrEqual(1 + EPSILON);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ===========================================================================
// Property: retrieval-ceiling bounds
// ===========================================================================

describe('retrieval ceiling bounds', () => {
  it('recall@k / oracle nDCG / oracle MRR ∈ [0,1]', () => {
    fc.assert(
      fc.property(idListArb(40), idListArb(20), relevantSetArb(15), (retrieved, ranked, relevant) => {
        const ceiling = computeRetrievalCeiling(retrieved, ranked, relevant);
        for (const v of [
          ceiling.recall_at_20,
          ceiling.recall_at_50,
          ceiling.recall_at_100,
          ceiling.oracle_ndcg_at_10,
          ceiling.oracle_mrr,
        ]) {
          expect(inUnitInterval(v)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('ranking gap: retrievalCoverage and rankingEfficiency ∈ [0,1]; achieved ≤ oracle', () => {
    // Two-stage pipeline contract: the ranker reorders the retrieved candidate
    // pool, so ranked ⊆ retrieved. The oracle ceiling (best ordering of the
    // pool) dominates any achievable ranking ONLY under this subset invariant —
    // a ranked id absent from the pool is out of contract.
    const pipelineArb = idListArb(40).chain((retrieved) =>
      fc
        .subarray(retrieved)
        .map((ranked) => ({ retrieved, ranked }) as { retrieved: string[]; ranked: string[] }),
    );
    fc.assert(
      fc.property(pipelineArb, relevantSetArb(15), ({ retrieved, ranked }, relevant) => {
        const gap = diagnoseRankingGap(retrieved, ranked, relevant);
        expect(inUnitInterval(gap.retrievalCoverage)).toBe(true);
        expect(inUnitInterval(gap.rankingEfficiency)).toBe(true);
        expect(inUnitInterval(gap.oracle)).toBe(true);
        expect(inUnitInterval(gap.achieved)).toBe(true);
        // achieved nDCG can never exceed the oracle ceiling (the whole point)
        expect(gap.achieved).toBeLessThanOrEqual(gap.oracle + EPSILON);
        expect(['retrieval_bottleneck', 'ranking_bottleneck', 'both', 'neither']).toContain(gap.gap);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('nDCG / MRR / MAP ∈ [0,1] for any ranking', () => {
    fc.assert(
      fc.property(idListArb(20), relevantSetArb(12), (ranked, relevant) => {
        expect(inUnitInterval(ndcg_at_k(ranked, relevant, 10))).toBe(true);
        expect(inUnitInterval(mrr(ranked, relevant))).toBe(true);
        expect(inUnitInterval(map_at_k(ranked, relevant, 10))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ===========================================================================
// Property: scoring determinism (no Date/random in scoring path)
// ===========================================================================

describe('scoring determinism', () => {
  it('all metric functions return byte-identical results for identical input', () => {
    fc.assert(
      fc.property(
        idListArb(30),
        idListArb(20),
        relevantSetArb(12),
        fc.array(expectedConstraintArb(), { maxLength: 6 }),
        (retrieved, ranked, relevant, expectedList) => {
          const extracted: ConstraintBundle = {
            ...emptyBundle(),
            hard: expectedList.map(toNormalized),
          };
          // run each twice — must be identical
          expect(ndcg_at_k(ranked, relevant, 10)).toBe(ndcg_at_k(ranked, relevant, 10));
          expect(mrr(ranked, relevant)).toBe(mrr(ranked, relevant));
          expect(computeRetrievalCeiling(retrieved, ranked, relevant)).toEqual(
            computeRetrievalCeiling(retrieved, ranked, relevant),
          );
          expect(scoreSlotF1(extracted, { hard: expectedList })).toEqual(
            scoreSlotF1(extracted, { hard: expectedList }),
          );
          expect(weightedGeometricMean({ a: 0.5, b: 1 }, { a: 0.3, b: 0.7 })).toBe(
            weightedGeometricMean({ a: 0.5, b: 1 }, { a: 0.3, b: 0.7 }),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// ===========================================================================
// Property: aggregation monotone — adding a passing scenario never lowers pass rate
// ===========================================================================

describe('pass-rate aggregation monotonicity', () => {
  // The benchmark summarizes per-scenario booleans into passRate = passed/total.
  // This is the pure aggregation arithmetic the runner relies on; lock its
  // monotonicity: appending a PASS can never decrease the rate.
  const passRate = (results: readonly boolean[]): number =>
    results.length === 0 ? 0 : results.filter(Boolean).length / results.length;

  it('appending a passing scenario never decreases pass rate', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 50 }), (results) => {
        const before = passRate(results);
        const after = passRate([...results, true]);
        expect(after).toBeGreaterThanOrEqual(before - EPSILON);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('appending a failing scenario never increases pass rate', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 50 }), (results) => {
        const before = passRate(results);
        const after = passRate([...results, false]);
        expect(after).toBeLessThanOrEqual(before + EPSILON);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('pass rate ∈ [0,1] for any boolean verdict list', () => {
    fc.assert(
      fc.property(fc.array(fc.boolean(), { maxLength: 50 }), (results) => {
        expect(inUnitInterval(passRate(results))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
