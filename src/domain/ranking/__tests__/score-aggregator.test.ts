import { describe, it, expect } from 'vitest';
import { ScoreAggregator } from '../service/score-aggregator.js';
import { DEFAULT_WEIGHTS, resolveWeights } from '../model/scoring-weights.js';
import type { ComponentScores } from '../model/ranked-result.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const PASS_SIGNALS: ComponentScores = {
  entityIntegrity: 0.5,
  anchorSimilarity: 0,
  semantic: 0,
  hardConstraintPass: true,
  softConstraint: 0,
  attributeAlignment: 0,
  preferenceAlignment: 0,
  popularity: 0,
  availability: 0,
  uncertaintyPenalty: 0,
};

function makeSignals(overrides: Partial<ComponentScores> = {}): ComponentScores {
  return { ...PASS_SIGNALS, ...overrides };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ScoreAggregator', () => {
  const aggregator = new ScoreAggregator();
  const weights = DEFAULT_WEIGHTS;

  describe('gate: hard constraint fail', () => {
    it('hardConstraintPass=false → -Infinity', () => {
      const signals = makeSignals({ hardConstraintPass: false });
      expect(aggregator.aggregate(signals, weights)).toBe(-Infinity);
    });

    it('hardConstraintPass=false even with high other signals → -Infinity', () => {
      const signals = makeSignals({
        hardConstraintPass: false,
        entityIntegrity: 1.0,
        semantic: 1.0,
        popularity: 1.0,
      });
      expect(aggregator.aggregate(signals, weights)).toBe(-Infinity);
    });
  });

  describe('gate: entity integrity below threshold', () => {
    it('entityIntegrity < entityIntegrityThreshold → -Infinity', () => {
      // Default threshold is 0.3
      const signals = makeSignals({ entityIntegrity: 0.1 });
      expect(aggregator.aggregate(signals, weights)).toBe(-Infinity);
    });

    it('entityIntegrity exactly at threshold → NOT -Infinity (passes)', () => {
      // threshold is 0.3; entityIntegrity=0.3 should pass
      const signals = makeSignals({ entityIntegrity: 0.3 });
      const result = aggregator.aggregate(signals, weights);
      expect(result).not.toBe(-Infinity);
    });

    it('entityIntegrity below threshold overrides hard constraint pass', () => {
      const signals = makeSignals({
        hardConstraintPass: true,
        entityIntegrity: 0.0,
      });
      expect(aggregator.aggregate(signals, weights)).toBe(-Infinity);
    });
  });

  describe('single signal contribution', () => {
    it('all signals zero except semantic → semantic weight × value', () => {
      const semanticValue = 0.8;
      const signals = makeSignals({ semantic: semanticValue });
      const expected = semanticValue * weights.semantic;
      // Only entityIntegrity contributes: 0.5 * 0.15 = 0.075 (from PASS_SIGNALS)
      // Plus semantic: 0.8 * 0.25 = 0.2
      const actual = aggregator.aggregate(signals, weights);
      // entityIntegrity=0.5 contribution: 0.5 * 0.15 = 0.075
      const entityIntegrityContrib = PASS_SIGNALS.entityIntegrity * weights.entityIntegrity;
      expect(actual).toBeCloseTo(expected + entityIntegrityContrib, 10);
    });

    it('all signals zero (except passing gates) → small score from entityIntegrity only', () => {
      const signals = makeSignals({
        entityIntegrity: 0.5,
        semantic: 0,
        softConstraint: 0,
        attributeAlignment: 0,
        preferenceAlignment: 0,
        popularity: 0,
        availability: 0,
        uncertaintyPenalty: 0,
      });
      // 0.5 * 0.15 = 0.075
      expect(aggregator.aggregate(signals, weights)).toBeCloseTo(0.075, 10);
    });

    it('popularity contributes its weight × value', () => {
      const signals = makeSignals({ popularity: 1.0 });
      const result = aggregator.aggregate(signals, weights);
      // entityIntegrity: 0.5*0.15=0.075, popularity: 1.0*0.03=0.03
      expect(result).toBeCloseTo(0.075 + 0.03, 10);
    });
  });

  describe('uncertaintyPenalty', () => {
    it('uncertaintyPenalty subtracts from total', () => {
      const withoutPenalty = makeSignals({ uncertaintyPenalty: 0 });
      const withPenalty = makeSignals({ uncertaintyPenalty: 1.0 });

      const without = aggregator.aggregate(withoutPenalty, weights);
      const with_ = aggregator.aggregate(withPenalty, weights);
      // Penalty contribution: 1.0 * 0.05 = 0.05
      expect(without - with_).toBeCloseTo(weights.uncertaintyPenalty, 10);
    });

    it('large uncertainty penalty can reduce score to floor (0)', () => {
      const signals = makeSignals({
        entityIntegrity: 0.3,
        uncertaintyPenalty: 1.0,
        semantic: 0,
        softConstraint: 0,
      });
      const result = aggregator.aggregate(signals, weights);
      // entityIntegrity: 0.3 * 0.15 = 0.045; penalty: 1.0 * 0.05 = 0.05
      // score = 0.045 - 0.05 = -0.005 → clamped to 0
      expect(result).toBeGreaterThanOrEqual(0);
    });
  });

  describe('final score normalization', () => {
    it('final score is always >= 0 (clamped at floor)', () => {
      const signals = makeSignals({
        entityIntegrity: 0.3,
        semantic: 0,
        uncertaintyPenalty: 1.0,
      });
      expect(aggregator.aggregate(signals, weights)).toBeGreaterThanOrEqual(0);
    });

    it('final score is always <= 1 (clamped at MAX_SCORE)', () => {
      const signals = makeSignals({
        entityIntegrity: 1.0,
        semantic: 1.0,
        softConstraint: 1.0,
        attributeAlignment: 1.0,
        preferenceAlignment: 1.0,
        popularity: 1.0,
        availability: 1.0,
        anchorSimilarity: 1.0,
        uncertaintyPenalty: 0,
      });
      expect(aggregator.aggregate(signals, weights)).toBeLessThanOrEqual(1);
    });

    it('maximum possible score does not exceed 1.0', () => {
      // Default weights do not sum to exactly 1.0 (they sum to ~0.95 without anchorSimilarity).
      // Even with all signals at 1.0, the score may be below 1.0 (no overflow) and
      // must always be clamped to [0, 1].
      const highSignals = makeSignals({
        entityIntegrity: 1.0,
        semantic: 1.0,
        softConstraint: 1.0,
        attributeAlignment: 1.0,
        preferenceAlignment: 1.0,
        popularity: 1.0,
        availability: 1.0,
        anchorSimilarity: 1.0,
        uncertaintyPenalty: 0,
      });
      const result = aggregator.aggregate(highSignals, weights);
      expect(result).toBeLessThanOrEqual(1.0);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('query-class-specific weights', () => {
    it('anchored_similarity weights raise anchorSimilarity contribution', () => {
      const anchoredWeights = resolveWeights('anchored_similarity');
      const defaultWeights = resolveWeights('semantic_preference');

      expect(anchoredWeights.anchorSimilarity).toBeGreaterThan(defaultWeights.anchorSimilarity);
    });

    it('pure_constraint weights raise softConstraint contribution', () => {
      const constraintWeights = resolveWeights('pure_constraint');
      const defaultWeights = DEFAULT_WEIGHTS;

      expect(constraintWeights.softConstraint).toBeGreaterThan(defaultWeights.softConstraint);
    });
  });

  describe('weighted sum accuracy', () => {
    it('two-signal combination computes correctly', () => {
      const signals = makeSignals({
        entityIntegrity: 1.0,
        semantic: 1.0,
        softConstraint: 0,
        attributeAlignment: 0,
        preferenceAlignment: 0,
        popularity: 0,
        availability: 0,
        uncertaintyPenalty: 0,
      });
      // entityIntegrity: 1.0 * 0.15 = 0.15
      // semantic: 1.0 * 0.25 = 0.25
      // total = 0.40
      expect(aggregator.aggregate(signals, weights)).toBeCloseTo(0.40, 10);
    });
  });
});
