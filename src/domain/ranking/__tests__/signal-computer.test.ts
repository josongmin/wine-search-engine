import { describe, expect, it } from 'vitest';
import { SignalComputer } from '../service/signal-computer.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';

function makeCandidate(overrides: Partial<HybridCandidate> = {}): HybridCandidate {
  return {
    entityId: 'entity-1' as never,
    retrievalFusionScore: 0.08,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'test',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: [],
    },
    ...overrides,
  };
}

describe('SignalComputer SOTA++ signals', () => {
  const computer = new SignalComputer();

  // ── computeProducerPrestige ──────────────────────────────────────────────────
  describe('computeProducerPrestige', () => {
    it('returns 0.5 (neutral) when producerPrestige is absent', () => {
      expect(computer.computeProducerPrestige(makeCandidate())).toBe(0.5);
    });
    it('returns value as-is when in [0, 1]', () => {
      expect(computer.computeProducerPrestige(makeCandidate({ producerPrestige: 0.8 }))).toBeCloseTo(0.8);
    });
    it('clamps above 1 down to 1', () => {
      expect(computer.computeProducerPrestige(makeCandidate({ producerPrestige: 1.5 }))).toBe(1);
    });
    it('clamps below 0 up to 0', () => {
      expect(computer.computeProducerPrestige(makeCandidate({ producerPrestige: -0.2 }))).toBe(0);
    });
  });

  // ── computeRecency ───────────────────────────────────────────────────────────
  describe('computeRecency', () => {
    it('returns undefined when vintageYear is absent', () => {
      expect(computer.computeRecency(makeCandidate(), 2026)).toBeUndefined();
    });
    it('returns 1.0 when vintage equals reference year (age delta = 0)', () => {
      expect(computer.computeRecency(makeCandidate({ vintageYear: 2026 }), 2026)).toBeCloseTo(1.0);
    });
    it('returns ~0.5 after 8 years (half-life)', () => {
      const score = computer.computeRecency(makeCandidate({ vintageYear: 2018 }), 2026);
      expect(score).toBeCloseTo(0.5, 2);
    });
    it('returns near 0 for vintages older than 30 years', () => {
      const score = computer.computeRecency(makeCandidate({ vintageYear: 1990 }), 2026);
      expect(score).toBeLessThan(0.05);
    });
  });

  // ── computeCriticScore ───────────────────────────────────────────────────────
  describe('computeCriticScore', () => {
    it('returns undefined when criticScoreNormalized is absent', () => {
      expect(computer.computeCriticScore(makeCandidate())).toBeUndefined();
    });
    it('returns value as-is when in [0, 1]', () => {
      expect(computer.computeCriticScore(makeCandidate({ criticScoreNormalized: 0.92 }))).toBeCloseTo(0.92);
    });
    it('clamps out-of-range values', () => {
      expect(computer.computeCriticScore(makeCandidate({ criticScoreNormalized: 1.3 }))).toBe(1);
    });
  });

  // ── computeMultilingualScore ─────────────────────────────────────────────────
  describe('computeMultilingualScore', () => {
    it('returns 0 when query has no Hangul regardless of candidate searchTextKo', () => {
      expect(computer.computeMultilingualScore(makeCandidate({ searchTextKo: '한국어' }), false)).toBe(0);
    });
    it('returns 0 when query has Hangul but candidate has no searchTextKo', () => {
      expect(computer.computeMultilingualScore(makeCandidate(), true)).toBe(0);
    });
    it('returns 0 when query has Hangul but searchTextKo is empty string', () => {
      expect(computer.computeMultilingualScore(makeCandidate({ searchTextKo: '' }), true)).toBe(0);
    });
    it('returns 1 when query has Hangul AND candidate has non-empty searchTextKo', () => {
      expect(computer.computeMultilingualScore(makeCandidate({ searchTextKo: '오퍼스원' }), true)).toBe(1);
    });
  });
});

describe('SignalComputer specialized signals', () => {
  const computer = new SignalComputer();

  it('computes set coverage from observed candidate metadata', () => {
    const coverage = computer.computeSetCoverage(
      [
        makeCandidate({ producer: 'Antinori', region: 'Tuscany' }),
        makeCandidate({ grapePrimary: 'Sangiovese', vintageYear: 2019 }),
      ],
      new Set(['antinori', 'sangiovese', 'bordeaux']),
    );

    expect(coverage).toBeCloseTo(2 / 3, 5);
  });

  it('computes anchor preservation from shared metadata and attribute similarity', () => {
    const score = computer.computeAnchorPreservation(
      makeCandidate({
        region: 'Napa Valley',
        grapePrimary: 'Cabernet Sauvignon',
        body: 4,
        tannin: 4,
        acidity: 3,
      }),
      makeCandidate({
        region: 'Napa Valley',
        grapePrimary: 'Cabernet Sauvignon',
        body: 4,
        tannin: 3,
        acidity: 3,
        retrievalFusionScore: 0.09,
      }),
    );

    expect(score).toBeGreaterThan(0.8);
  });
});
