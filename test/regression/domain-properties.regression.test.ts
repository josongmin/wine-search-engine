/**
 * Property-based tests for pure domain functions with strong invariants.
 *
 * Targets identified by the L15 audit:
 * - editDistance (Levenshtein): metric properties
 * - canonicalJsonStringify: determinism + key-order invariance
 * - ScoreAggregator: gates + bounded output + monotonicity
 *
 * Append-only.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { editDistance } from '../../src/domain/alias/service/alias-matcher.js';
import { canonicalJsonStringify } from '../../src/domain/shared/utils/canonical-json.js';
import { ScoreAggregator } from '../../src/domain/ranking/service/score-aggregator.js';


// ─────────────────────────────────────────────────────────────────────────────
// editDistance — Levenshtein metric properties
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: editDistance (Levenshtein)', () => {
  it('non-negative for any input pair', async () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => editDistance(a, b) >= 0),
      { numRuns: 200 },
    );
  });

  it('identity: d(a, a) === 0', async () => {
    fc.assert(
      fc.property(fc.string(), (a) => editDistance(a, a) === 0),
      { numRuns: 200 },
    );
  });

  it('symmetry: d(a, b) === d(b, a)', async () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => editDistance(a, b) === editDistance(b, a)),
      { numRuns: 200 },
    );
  });

  it('triangle inequality: d(a,c) <= d(a,b) + d(b,c)', async () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }),
        fc.string({ maxLength: 30 }),
        fc.string({ maxLength: 30 }),
        (a, b, c) => editDistance(a, c) <= editDistance(a, b) + editDistance(b, c),
      ),
      { numRuns: 100 },
    );
  });

  it('upper bound: d(a, b) <= max(|a|, |b|)', async () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return editDistance(a, b) <= Math.max(a.length, b.length);
      }),
      { numRuns: 200 },
    );
  });

  it('lower bound: d(a, b) >= ||a| - |b||', async () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        return editDistance(a, b) >= Math.abs(a.length - b.length);
      }),
      { numRuns: 200 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canonicalJsonStringify — determinism + key-order invariance
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: canonicalJsonStringify', () => {
  it('roundtrip stable: parse(stringify(x)) yields the same canonical string', async () => {
    // Replaces a tautological "f(x) === f(x)" test that proved nothing.
    // True invariant: stringify is a fixed point under JSON parse roundtrip.
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1 }).filter((s) => !s.includes('\u0000')),
          fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
        ),
        (obj) => {
          const first = canonicalJsonStringify(obj);
          const reparsed: unknown = JSON.parse(first);
          const second = canonicalJsonStringify(reparsed);
          return first === second;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('key-order invariance: shuffling keys produces identical output', async () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 10 })
          .filter((s) => !s.includes('\u0000')), { minLength: 2, maxLength: 8 }),
        fc.array(fc.integer(), { minLength: 2, maxLength: 8 }),
        (keys, values) => {
          const n = Math.min(keys.length, values.length);
          const objA: Record<string, number> = {};
          const objB: Record<string, number> = {};
          // Insert in two different orders
          for (let i = 0; i < n; i++) objA[keys[i]!] = values[i]!;
          for (let i = n - 1; i >= 0; i--) objB[keys[i]!] = values[i]!;
          return canonicalJsonStringify(objA) === canonicalJsonStringify(objB);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('omits undefined values', async () => {
    const withUndef = canonicalJsonStringify({ a: 1, b: undefined, c: 3 });
    const without = canonicalJsonStringify({ a: 1, c: 3 });
    expect(withUndef).toBe(without);
  });

  it('-0 normalizes to 0', async () => {
    expect(canonicalJsonStringify({ a: -0 })).toBe(canonicalJsonStringify({ a: 0 }));
  });

  it('throws on NaN', async () => {
    expect(() => canonicalJsonStringify({ a: NaN })).toThrow();
  });

  it('throws on Infinity', async () => {
    expect(() => canonicalJsonStringify({ a: Infinity })).toThrow();
  });

  it('throws on Date (non-POJO)', async () => {
    expect(() => canonicalJsonStringify({ d: new Date() })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ScoreAggregator — gates + bounded + monotone
// ─────────────────────────────────────────────────────────────────────────────

describe('Property: ScoreAggregator.aggregate', () => {
  // Helper: minimal valid signals
  function makeSignals(overrides: Record<string, number | boolean> = {}) {
    return {
      entityIntegrity: 1.0,
      semantic: 0.5,
      hardConstraintPass: true,
      softConstraint: 0.5,
      attributeAlignment: 0.5,
      preferenceAlignment: 0.5,
      popularity: 0.5,
      availability: 0.5,
      uncertaintyPenalty: 0,
      ...overrides,
    } as Parameters<import('../../src/domain/ranking/service/score-aggregator.js').ScoreAggregator['aggregate']>[0];
  }

  // Helper: minimal valid weights
  function makeWeights(overrides: Record<string, number> = {}) {
    return {
      entityIntegrity: 0.1,
      anchorSimilarity: 0.1,
      semantic: 0.2,
      softConstraint: 0.1,
      attributeAlignment: 0.15,
      preferenceAlignment: 0.05,
      popularity: 0.05,
      availability: 0.1,
      uncertaintyPenalty: 0.1,
      entityIntegrityThreshold: 0.3,
      producerPrestige: 0,
      recency: 0,
      criticScore: 0,
      multilingualScore: 0,
      ...overrides,
    } as Parameters<import('../../src/domain/ranking/service/score-aggregator.js').ScoreAggregator['aggregate']>[1];
  }

  it('hardConstraintPass=false → -Infinity regardless of any other signal value', async () => {
    const aggregator = new ScoreAggregator();
    const unitFloat = fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });
    fc.assert(
      fc.property(
        fc.record({
          entityIntegrity: unitFloat,
          semantic: unitFloat,
          softConstraint: unitFloat,
          attributeAlignment: unitFloat,
          preferenceAlignment: unitFloat,
          popularity: unitFloat,
          availability: unitFloat,
          uncertaintyPenalty: unitFloat,
          anchorSimilarity: unitFloat,
          producerPrestige: unitFloat,
          recency: unitFloat,
          criticScore: unitFloat,
          multilingualScore: unitFloat,
        }),
        (signals) => {
          const result = aggregator.aggregate(
            makeSignals({ ...signals, hardConstraintPass: false }),
            makeWeights(),
          );
          // Gate must dominate every other signal
          return result === -Infinity;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('entityIntegrity below threshold → -Infinity always', async () => {
    const aggregator = new ScoreAggregator();
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(0.29), noNaN: true, noDefaultInfinity: true }),
        (eIntegrity) => {
          const result = aggregator.aggregate(
            makeSignals({ entityIntegrity: eIntegrity }),
            makeWeights({ entityIntegrityThreshold: 0.3 }),
          );
          return result === -Infinity;
        },
      ),
      { numRuns: 50 },
    );
  });

  it('passing gates → output in [0, 1]', async () => {
    const aggregator = new ScoreAggregator();
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.5), max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (eIntegrity, semantic, soft) => {
          const result = aggregator.aggregate(
            makeSignals({ entityIntegrity: eIntegrity, semantic, softConstraint: soft }),
            makeWeights(),
          );
          return result >= 0 && result <= 1;
        },
      ),
      { numRuns: 100 },
    );
  });

  // Test the zero-weight invariant for EVERY weighted signal, not just popularity.
  // A future bug where (e.g.) recency leaks despite weight=0 would not be caught
  // by a popularity-only test.
  const ZERO_WEIGHT_SIGNALS = [
    'popularity', 'producerPrestige', 'recency', 'criticScore', 'multilingualScore',
    'attributeAlignment', 'preferenceAlignment', 'availability',
  ] as const;
  for (const sigName of ZERO_WEIGHT_SIGNALS) {
    it(`zero weight on ${sigName} → signal is irrelevant`, async () => {
      const aggregator = new ScoreAggregator();
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          (valA, valB) => {
            const a = aggregator.aggregate(
              makeSignals({ [sigName]: valA }),
              makeWeights({ [sigName]: 0 }),
            );
            const b = aggregator.aggregate(
              makeSignals({ [sigName]: valB }),
              makeWeights({ [sigName]: 0 }),
            );
            return a === b;
          },
        ),
        { numRuns: 50 },
      );
    });
  }

  it('uncertaintyPenalty monotone: more penalty → lower-or-equal score', async () => {
    const aggregator = new ScoreAggregator();
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(0.5), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 0, max: Math.fround(0.5), noNaN: true, noDefaultInfinity: true }),
        (penaltyLow, extra) => {
          const penaltyHigh = penaltyLow + extra;
          const a = aggregator.aggregate(
            makeSignals({ uncertaintyPenalty: penaltyLow }),
            makeWeights(),
          );
          const b = aggregator.aggregate(
            makeSignals({ uncertaintyPenalty: penaltyHigh }),
            makeWeights(),
          );
          // Higher penalty must produce score <= lower penalty score
          return b <= a;
        },
      ),
      { numRuns: 50 },
    );
  });
});
