import type { ComponentScores } from '../model/ranked-result.js';
import type { ScoringWeights } from '../model/scoring-weights.js';

/**
 * Upper bound for the normalized final ranking score.
 * Scores are clamped to [0, MAX_SCORE] to maintain a bounded range.
 */
const MAX_SCORE = 1.0;

/**
 * Aggregates individual signal scores into a single ranking score.
 *
 * Implements the scoring formula from RFC-013:
 *   Score(e) = entity_integrity + anchor_similarity + hard_constraint_pass
 *            + soft_constraint + semantic_relevance + attribute_alignment
 *            + preference + popularity + availability - uncertainty_penalty
 *
 * Gate signals (hard constraint pass, entity integrity threshold) are
 * evaluated first. If a gate fails, the score is -Infinity and the
 * candidate is filtered out.
 *
 * This is a pure computation class with no side effects or I/O.
 */
export class ScoreAggregator {
  /**
   * Aggregates component scores into a single final ranking score.
   *
   * @param signals - The individual signal scores for a candidate.
   * @param weights - The scoring weight configuration.
   * @returns The aggregated ranking score. Returns -Infinity for gated-out candidates.
   */
  aggregate(signals: ComponentScores, weights: ScoringWeights): number {
    // Gate 1: Hard constraint pass — violate → score = -Infinity
    if (!signals.hardConstraintPass) {
      return -Infinity;
    }

    // Gate 2: Entity integrity below threshold → remove
    if (signals.entityIntegrity < weights.entityIntegrityThreshold) {
      return -Infinity;
    }

    // Weighted sum of non-gate signals
    let score = 0;

    score += signals.entityIntegrity * weights.entityIntegrity;
    score += (signals.anchorSimilarity ?? 0) * weights.anchorSimilarity;
    score += signals.semantic * weights.semantic;
    score += signals.softConstraint * weights.softConstraint;
    score += signals.attributeAlignment * weights.attributeAlignment;
    score += signals.preferenceAlignment * weights.preferenceAlignment;
    score += signals.popularity * weights.popularity;
    score += signals.availability * weights.availability;
    // SOTA++ signals — only contribute when the mode weights them (> 0)
    score += (signals.producerPrestige ?? 0) * weights.producerPrestige;
    score += (signals.recency ?? 0) * weights.recency;
    score += (signals.criticScore ?? 0) * weights.criticScore;
    score += (signals.multilingualScore ?? 0) * weights.multilingualScore;

    // Uncertainty penalty is subtracted
    score -= signals.uncertaintyPenalty * weights.uncertaintyPenalty;

    // Normalize to bounded range [0, MAX_SCORE]
    return Math.max(0, Math.min(MAX_SCORE, score));
  }
}
