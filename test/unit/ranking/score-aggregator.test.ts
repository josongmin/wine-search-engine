import { describe, it, expect } from 'vitest';
import { ScoreAggregator } from '../../../src/domain/ranking/service/score-aggregator.js';
import { DEFAULT_WEIGHTS } from '../../../src/domain/ranking/model/scoring-weights.js';
import type { ComponentScores } from '../../../src/domain/ranking/model/ranked-result.js';
import type { ScoringWeights } from '../../../src/domain/ranking/model/scoring-weights.js';

const aggregator = new ScoreAggregator();

function makeScores(overrides?: Partial<ComponentScores>): ComponentScores {
  return {
    entityIntegrity: 0,
    semantic: 0,
    hardConstraintPass: true,
    softConstraint: 0,
    attributeAlignment: 0,
    preferenceAlignment: 0,
    popularity: 0,
    availability: 0,
    uncertaintyPenalty: 0,
    ...overrides,
  };
}

describe('ScoreAggregator', () => {
  describe('gate signals', () => {
    it('hardConstraintPass=false → returns -Infinity', () => {
      const scores = makeScores({ hardConstraintPass: false, entityIntegrity: 0.9 });
      const result = aggregator.aggregate(scores, DEFAULT_WEIGHTS);
      expect(result).toBe(-Infinity);
    });

    it('entityIntegrity below threshold → returns -Infinity', () => {
      // DEFAULT_WEIGHTS.entityIntegrityThreshold = 0.3
      const scores = makeScores({ entityIntegrity: 0.1, hardConstraintPass: true });
      const result = aggregator.aggregate(scores, DEFAULT_WEIGHTS);
      expect(result).toBe(-Infinity);
    });

    it('entityIntegrity exactly at threshold → passes gate', () => {
      // threshold = 0.3; at exactly 0.3 it is NOT below threshold (< 0.3)
      const scores = makeScores({ entityIntegrity: 0.3, hardConstraintPass: true });
      const result = aggregator.aggregate(scores, DEFAULT_WEIGHTS);
      expect(result).not.toBe(-Infinity);
    });
  });

  describe('weighted scoring', () => {
    it('all signals zero except semantic=1.0 → weighted semantic score', () => {
      const scores = makeScores({
        entityIntegrity: 0.5, // above threshold
        semantic: 1.0,
      });
      // score = 0.5 * w_integrity + 1.0 * w_semantic + 0 + ... - 0
      // DEFAULT: entityIntegrity=0.15, semantic=0.25
      const expected = 0.5 * DEFAULT_WEIGHTS.entityIntegrity + 1.0 * DEFAULT_WEIGHTS.semantic;
      const result = aggregator.aggregate(scores, DEFAULT_WEIGHTS);
      expect(result).toBeCloseTo(expected, 10);
    });

    it('uncertaintyPenalty subtracts from total', () => {
      const withoutPenalty = makeScores({ entityIntegrity: 0.8, semantic: 0.5, uncertaintyPenalty: 0 });
      const withPenalty = makeScores({ entityIntegrity: 0.8, semantic: 0.5, uncertaintyPenalty: 1.0 });

      const scoreWithout = aggregator.aggregate(withoutPenalty, DEFAULT_WEIGHTS);
      const scoreWith = aggregator.aggregate(withPenalty, DEFAULT_WEIGHTS);

      expect(scoreWith).toBeLessThan(scoreWithout);
      // Difference should be weight_uncertainty * 1.0
      expect(scoreWithout - scoreWith).toBeCloseTo(DEFAULT_WEIGHTS.uncertaintyPenalty * 1.0, 10);
    });

    it('final score is bounded to [0, 1]', () => {
      // Even with large signals, score should be clamped to 1.0
      const scores = makeScores({
        entityIntegrity: 1.0,
        semantic: 1.0,
        softConstraint: 1.0,
        attributeAlignment: 1.0,
        preferenceAlignment: 1.0,
        popularity: 1.0,
        availability: 1.0,
        hardConstraintPass: true,
        uncertaintyPenalty: 0,
      });
      const result = aggregator.aggregate(scores, DEFAULT_WEIGHTS);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('score is clamped to 0 for heavy uncertainty penalty', () => {
      const scores = makeScores({
        entityIntegrity: 0.5,
        semantic: 0.0,
        uncertaintyPenalty: 100, // massive penalty
      });
      const result = aggregator.aggregate(scores, DEFAULT_WEIGHTS);
      expect(result).toBe(0); // clamped to 0 — not just >= 0
    });

    it('anchorSimilarity=undefined treated as 0', () => {
      const withAnchor = makeScores({ entityIntegrity: 0.8, anchorSimilarity: 0.5 });
      const withoutAnchor = makeScores({ entityIntegrity: 0.8 }); // undefined

      const scoreWithAnchor = aggregator.aggregate(withAnchor, DEFAULT_WEIGHTS);
      const scoreWithoutAnchor = aggregator.aggregate(withoutAnchor, DEFAULT_WEIGHTS);

      // With anchor (even at 0 weight in DEFAULT_WEIGHTS), no difference for anchor=0 vs undefined
      // DEFAULT_WEIGHTS.anchorSimilarity = 0
      expect(scoreWithAnchor).toBeCloseTo(scoreWithoutAnchor, 10);
    });
  });

  describe('custom weights', () => {
    it('custom weights with high semantic weight amplifies semantic signal', () => {
      const highSemanticWeights: ScoringWeights = {
        ...DEFAULT_WEIGHTS,
        semantic: 0.8,
      };
      const lowSemanticWeights: ScoringWeights = {
        ...DEFAULT_WEIGHTS,
        semantic: 0.1,
      };

      const scores = makeScores({ entityIntegrity: 0.5, semantic: 0.5 });
      const highScore = aggregator.aggregate(scores, highSemanticWeights);
      const lowScore = aggregator.aggregate(scores, lowSemanticWeights);

      expect(highScore).toBeGreaterThan(lowScore);
    });
  });
});
