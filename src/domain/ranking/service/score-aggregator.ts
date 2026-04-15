import type { ComponentScores } from '../model/ranked-result.js';
import type { ScoringWeights } from '../model/scoring-weights.js';
import { clamp01 } from '../../shared/utils/clamp.js';

/**
 * C4 (fail-loud): thrown when a signal that was computed (i.e. the
 * signal-computer returned a number) is non-finite. Absent signals
 * (undefined) are NOT a defect — they simply drop out of the weighted
 * sum. Only NaN/Infinity from a COMPUTED signal is a defect.
 *
 * Ranker must catch this and convert the candidate to a gated-out result
 * with degradation reason `ranking_invalid_signal`. It MUST NOT silently
 * substitute 0 and proceed.
 */
export class RankComputationError extends Error {
  readonly signalName: string;
  readonly signalValue: number;
  readonly componentScoresSnapshot: Readonly<Record<string, unknown>>;

  constructor(signalName: string, signalValue: number, snapshot: Readonly<Record<string, unknown>>) {
    super(
      `ScoreAggregator: signal '${signalName}' is non-finite (value=${String(signalValue)}). ` +
      'This is a contract violation — signal-computer emitted NaN/Infinity. ' +
      'Ranker must fail this candidate with ranking_invalid_signal rather than silently zeroing.',
    );
    this.name = 'RankComputationError';
    this.signalName = signalName;
    this.signalValue = signalValue;
    this.componentScoresSnapshot = snapshot;
  }
}

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
 * C4 (fail-loud): NaN/Infinity on a COMPUTED signal throws {@link RankComputationError}.
 * Missing signals (undefined) contribute 0 weight (legit absence).
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
   * @throws RankComputationError when a COMPUTED signal is non-finite.
   */
  aggregate(signals: ComponentScores, weights: ScoringWeights): number {
    // Gate 1: Hard constraint pass — violate → score = -Infinity
    if (!signals.hardConstraintPass) {
      return -Infinity;
    }

    // Gate 2: Entity integrity below threshold → remove.
    // entityIntegrity is REQUIRED (not optional) — a non-finite value here is
    // a contract violation from the signal computer.
    if (!Number.isFinite(signals.entityIntegrity)) {
      throw new RankComputationError('entityIntegrity', signals.entityIntegrity, snapshotOf(signals));
    }
    if (signals.entityIntegrity < weights.entityIntegrityThreshold) {
      return -Infinity;
    }

    // Fail-loud adder: undefined = legitimate absence, skipped from the sum.
    //                  NaN/Infinity = computed-but-corrupt → throw.
    const add = (name: string, value: number | undefined, weight: number): number => {
      if (value === undefined) return 0;
      if (!Number.isFinite(value)) {
        throw new RankComputationError(name, value, snapshotOf(signals));
      }
      return value * weight;
    };

    let score = 0;
    score += add('entityIntegrity', signals.entityIntegrity, weights.entityIntegrity);
    score += add('anchorSimilarity', signals.anchorSimilarity, weights.anchorSimilarity);
    score += add('semantic', signals.semantic, weights.semantic);
    score += add('softConstraint', signals.softConstraint, weights.softConstraint);
    score += add('attributeAlignment', signals.attributeAlignment, weights.attributeAlignment);
    score += add('preferenceAlignment', signals.preferenceAlignment, weights.preferenceAlignment);
    score += add('popularity', signals.popularity, weights.popularity);
    score += add('availability', signals.availability, weights.availability);
    score += add('producerPrestige', signals.producerPrestige, weights.producerPrestige);
    score += add('recency', signals.recency, weights.recency);
    score += add('criticScore', signals.criticScore, weights.criticScore);
    score += add('multilingualScore', signals.multilingualScore, weights.multilingualScore);

    // Uncertainty penalty is subtracted. Same contract: undefined skips,
    // NaN/Infinity throws.
    score -= add('uncertaintyPenalty', signals.uncertaintyPenalty, weights.uncertaintyPenalty);

    // Final hard guard against any remaining non-finite drift, then clamp
    // to bounded output range. -Infinity sentinels remain caller-handled.
    //
    // NOTE: weights are tuned so the realistic max sum is <= 1.0; when
    // mode-overlay produces sums > 1, ranker.ts performs a separate
    // mode-aware re-normalization. Hard clamp here is correct under those
    // assumptions, but watch for top-end saturation under future weight tuning.
    if (!Number.isFinite(score)) {
      // Drift from overflow/underflow in the weighted sum itself; treat as
      // computational defect rather than silent -Infinity.
      throw new RankComputationError('aggregatedScore', score, snapshotOf(signals));
    }
    return clamp01(score);
  }
}

function snapshotOf(signals: ComponentScores): Readonly<Record<string, unknown>> {
  // Shallow snapshot for error reporting. Avoids structured cloning cost
  // on the happy path; only touched when RankComputationError is thrown.
  return {
    entityIntegrity: signals.entityIntegrity,
    anchorSimilarity: signals.anchorSimilarity,
    semantic: signals.semantic,
    softConstraint: signals.softConstraint,
    attributeAlignment: signals.attributeAlignment,
    preferenceAlignment: signals.preferenceAlignment,
    popularity: signals.popularity,
    availability: signals.availability,
    producerPrestige: signals.producerPrestige,
    recency: signals.recency,
    criticScore: signals.criticScore,
    multilingualScore: signals.multilingualScore,
    uncertaintyPenalty: signals.uncertaintyPenalty,
    hardConstraintPass: signals.hardConstraintPass,
  };
}
