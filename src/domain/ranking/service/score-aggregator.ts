import type { ComponentScores } from '../model/ranked-result.js';
import type { ScoringWeights } from '../model/scoring-weights.js';
import { clamp01 } from '../../shared/utils/clamp.js';

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

    // Weighted sum of non-gate signals.
    // Each term is guarded with finiteOr0() so a NaN/Infinity from a single
    // signal cannot poison the entire score (which would propagate to the
    // sort comparator and produce non-deterministic ordering — RFC-009/015
    // determinism gate).
    const finiteOr0 = (n: number): number => (Number.isFinite(n) ? n : 0);
    let score = 0;

    score += finiteOr0(signals.entityIntegrity) * weights.entityIntegrity;
    score += finiteOr0(signals.anchorSimilarity ?? 0) * weights.anchorSimilarity;
    score += finiteOr0(signals.semantic) * weights.semantic;
    score += finiteOr0(signals.softConstraint) * weights.softConstraint;
    score += finiteOr0(signals.attributeAlignment) * weights.attributeAlignment;
    score += finiteOr0(signals.preferenceAlignment) * weights.preferenceAlignment;
    score += finiteOr0(signals.popularity) * weights.popularity;
    score += finiteOr0(signals.availability) * weights.availability;
    // SOTA++ signals — only contribute when the mode weights them (> 0)
    score += finiteOr0(signals.producerPrestige ?? 0) * weights.producerPrestige;
    score += finiteOr0(signals.recency ?? 0) * weights.recency;
    score += finiteOr0(signals.criticScore ?? 0) * weights.criticScore;
    score += finiteOr0(signals.multilingualScore ?? 0) * weights.multilingualScore;

    // Uncertainty penalty is subtracted
    score -= finiteOr0(signals.uncertaintyPenalty) * weights.uncertaintyPenalty;

    // Final hard guard against any remaining non-finite drift, then clamp
    // to bounded output range. -Infinity sentinels remain caller-handled.
    //
    // NOTE: weights are tuned so the realistic max sum is ≤ 1.0; when
    // mode-overlay produces sums > 1, ranker.ts performs a separate
    // mode-aware re-normalization. Hard clamp here is correct under those
    // assumptions, but watch for top-end saturation under future weight tuning.
    if (!Number.isFinite(score)) return -Infinity;
    return clamp01(score);
  }
}
