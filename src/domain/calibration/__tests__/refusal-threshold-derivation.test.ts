import { describe, it, expect } from 'vitest';
import {
  deriveRefusalThresholdForClass,
  deriveRefusalThresholds,
  groupByQueryClass,
  type RefusalDerivationSample,
} from '../service/refusal-threshold-derivation.js';

/**
 * Tests for the pure AURC-derived refusal-threshold derivation core.
 *
 * Synthetic distributions are designed so the optimal τ is known analytically:
 * if N samples are sorted by score and target_coverage = 0.8, the derived τ
 * MUST be the score at the 80th-percentile position (sorted descending).
 */

describe('groupByQueryClass', () => {
  it('drops non-finite scores defensively', () => {
    const samples: RefusalDerivationSample[] = [
      { score: 0.5, isCorrect: true, queryClass: 'a' },
      { score: Number.NaN, isCorrect: true, queryClass: 'a' },
      { score: Number.POSITIVE_INFINITY, isCorrect: false, queryClass: 'a' },
      { score: 0.3, isCorrect: false, queryClass: 'b' },
    ];
    const grouped = groupByQueryClass(samples);
    expect(grouped.get('a')?.length).toBe(1);
    expect(grouped.get('b')?.length).toBe(1);
  });

  it('returns empty map for empty input', () => {
    expect(groupByQueryClass([]).size).toBe(0);
  });

  it('preserves multiple classes', () => {
    const samples: RefusalDerivationSample[] = [
      { score: 0.5, isCorrect: true, queryClass: 'wine_name' },
      { score: 0.4, isCorrect: false, queryClass: 'producer' },
      { score: 0.3, isCorrect: true, queryClass: 'wine_name' },
    ];
    const grouped = groupByQueryClass(samples);
    expect(grouped.get('wine_name')?.length).toBe(2);
    expect(grouped.get('producer')?.length).toBe(1);
  });
});

describe('deriveRefusalThresholdForClass', () => {
  it('returns τ at the boundary of target coverage for uniform scores', () => {
    // 10 evenly spaced scores 0.05, 0.15, …, 0.95.
    // target_coverage = 0.5 → k=5 → τ is the 5th-highest = 0.55.
    const samples: RefusalDerivationSample[] = Array.from({ length: 10 }, (_, i) => ({
      score: (i + 0.5) / 10,
      isCorrect: true,
      queryClass: 'uniform',
    }));
    const result = deriveRefusalThresholdForClass('uniform', samples, {
      targetCoverage: 0.5,
    });
    expect(result.threshold).toBeCloseTo(0.55, 6);
    expect(result.sampleSize).toBe(10);
  });

  it('admits everything at target_coverage = 1.0', () => {
    const samples: RefusalDerivationSample[] = Array.from({ length: 5 }, (_, i) => ({
      score: (i + 1) / 10,
      isCorrect: i % 2 === 0,
      queryClass: 'all',
    }));
    const result = deriveRefusalThresholdForClass('all', samples, {
      targetCoverage: 1.0,
    });
    // τ must equal the LOWEST score so everyone is admitted.
    expect(result.threshold).toBeCloseTo(0.1, 6);
  });

  it('admits exactly the top score at coverage 1/N', () => {
    // N=4 means coverage 0.25 admits only the top sample.
    const samples: RefusalDerivationSample[] = [
      { score: 0.9, isCorrect: true, queryClass: 't' },
      { score: 0.7, isCorrect: true, queryClass: 't' },
      { score: 0.5, isCorrect: false, queryClass: 't' },
      { score: 0.3, isCorrect: false, queryClass: 't' },
    ];
    const result = deriveRefusalThresholdForClass('t', samples, {
      targetCoverage: 0.25,
    });
    expect(result.threshold).toBeCloseTo(0.9, 6);
  });

  it('reports observed risk at the chosen operating point', () => {
    // Top 3 correct, bottom 2 wrong. Coverage 0.6 → admit top 3 → risk 0.
    const samples: RefusalDerivationSample[] = [
      { score: 0.9, isCorrect: true, queryClass: 'r' },
      { score: 0.8, isCorrect: true, queryClass: 'r' },
      { score: 0.7, isCorrect: true, queryClass: 'r' },
      { score: 0.4, isCorrect: false, queryClass: 'r' },
      { score: 0.3, isCorrect: false, queryClass: 'r' },
    ];
    const result = deriveRefusalThresholdForClass('r', samples, {
      targetCoverage: 0.6,
    });
    expect(result.threshold).toBeCloseTo(0.7, 6);
    expect(result.riskAtCoverage).toBeCloseTo(0, 6);
    expect(result.aurc).toBeGreaterThanOrEqual(0);
  });

  it('throws for non-finite or out-of-range target coverage (adversarial)', () => {
    const samples: RefusalDerivationSample[] = [
      { score: 0.5, isCorrect: true, queryClass: 'x' },
    ];
    expect(() => deriveRefusalThresholdForClass('x', samples, { targetCoverage: 0 })).toThrow();
    expect(() => deriveRefusalThresholdForClass('x', samples, { targetCoverage: 1.5 })).toThrow();
    expect(() => deriveRefusalThresholdForClass('x', samples, { targetCoverage: Number.NaN })).toThrow();
  });

  it('throws on empty samples (adversarial)', () => {
    expect(() => deriveRefusalThresholdForClass('x', [], { targetCoverage: 0.5 })).toThrow();
  });

  it('handles N=1 deterministically (edge: smallest dataset)', () => {
    const samples: RefusalDerivationSample[] = [
      { score: 0.42, isCorrect: true, queryClass: 's' },
    ];
    const result = deriveRefusalThresholdForClass('s', samples, { targetCoverage: 0.5 });
    expect(result.threshold).toBeCloseTo(0.42, 6);
    expect(result.sampleSize).toBe(1);
  });
});

describe('deriveRefusalThresholds (multi-class)', () => {
  it('skips classes below min-samples and fits the rest', () => {
    const samples: RefusalDerivationSample[] = [
      // big class
      ...Array.from({ length: 4 }, (_, i) => ({
        score: (i + 1) / 5,
        isCorrect: true,
        queryClass: 'big',
      })),
      // tiny class
      { score: 0.5, isCorrect: false, queryClass: 'tiny' },
    ];
    const { fitted, skipped } = deriveRefusalThresholds(samples, {
      targetCoverage: 0.5,
      minSamplesPerClass: 3,
    });
    expect(fitted.length).toBe(1);
    expect(fitted[0]?.queryClass).toBe('big');
    expect(skipped.length).toBe(1);
    expect(skipped[0]?.queryClass).toBe('tiny');
  });

  it('returns deterministic ordering (legitimate input)', () => {
    const samples: RefusalDerivationSample[] = ['zeta', 'alpha', 'beta'].flatMap((qc) =>
      Array.from({ length: 4 }, (_, i) => ({
        score: (i + 1) / 5,
        isCorrect: true,
        queryClass: qc,
      })),
    );
    const { fitted } = deriveRefusalThresholds(samples, {
      targetCoverage: 0.5,
      minSamplesPerClass: 1,
    });
    expect(fitted.map((r) => r.queryClass)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('empty input yields empty result (edge)', () => {
    const out = deriveRefusalThresholds([], {
      targetCoverage: 0.5,
      minSamplesPerClass: 1,
    });
    expect(out.fitted).toEqual([]);
    expect(out.skipped).toEqual([]);
  });
});
