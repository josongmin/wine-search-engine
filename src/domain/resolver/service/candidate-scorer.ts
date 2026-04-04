import type { ResolverCandidate } from '../model/resolved-candidate.js';
import type { MatchSignalSet } from '../model/match-signal-set.js';

/**
 * Scoring weights for the weighted-sum scoring function, per RFC-006 §5.
 *
 * Weights reflect the relative importance of each match signal.
 * The hierarchy is: canonical > alias > producer > vintage > region > phonetic > edit_distance.
 * The ambiguity penalty is negative, reducing scores for ambiguous candidates.
 */
const SCORING_WEIGHTS = {
  canonicalExactMatch: 1.0,
  canonicalNormalizedMatch: 0.9,
  aliasExactMatch: 0.8,
  aliasFuzzyMatch: 0.5,
  producerMatch: 0.7,
  vintageMatch: 0.6,
  regionMatch: 0.5,
  grapeHintMatch: 0.3,
  phoneticMatch: 0.4,
  editDistanceScore: 0.3,
  ambiguityPenalty: -0.8,
} as const;

/**
 * Maximum contribution cap for catalog_noise_alias signals.
 * Prevents noisy aliases from dominating the score.
 */
const CATALOG_NOISE_ALIAS_CAP = 0.3;

/**
 * Scores resolution candidates using a weighted-sum function over
 * match signals, per RFC-006 §5.
 *
 * The scorer produces raw (uncalibrated) scores. These scores MUST be
 * calibrated by the {@link Calibrator} before any threshold comparison.
 */
export class CandidateScorer {
  /**
   * Computes a raw match score for a single candidate by applying the
   * weighted-sum formula to its source signals.
   *
   * @param candidate - A resolver candidate with populated source signals.
   * @returns A raw score (not calibrated). Higher is better.
   */
  score(candidate: ResolverCandidate): number {
    const signals = candidate.sourceSignals;
    const adjustedSignals = this.applyAliasCaps(signals, candidate);

    let total = 0;
    total += SCORING_WEIGHTS.canonicalExactMatch * adjustedSignals.canonicalExactMatch;
    total += SCORING_WEIGHTS.canonicalNormalizedMatch * adjustedSignals.canonicalNormalizedMatch;
    total += SCORING_WEIGHTS.aliasExactMatch * adjustedSignals.aliasExactMatch;
    total += SCORING_WEIGHTS.aliasFuzzyMatch * adjustedSignals.aliasFuzzyMatch;
    total += SCORING_WEIGHTS.producerMatch * adjustedSignals.producerMatch;
    total += SCORING_WEIGHTS.vintageMatch * adjustedSignals.vintageMatch;
    total += SCORING_WEIGHTS.regionMatch * adjustedSignals.regionMatch;
    total += SCORING_WEIGHTS.grapeHintMatch * adjustedSignals.grapeHintMatch;
    total += SCORING_WEIGHTS.phoneticMatch * adjustedSignals.phoneticMatch;
    total += SCORING_WEIGHTS.editDistanceScore * adjustedSignals.editDistanceScore;
    total += SCORING_WEIGHTS.ambiguityPenalty * adjustedSignals.ambiguityPenalty;

    return total;
  }

  /**
   * Applies alias-type-specific caps to prevent noisy alias sources from
   * inflating scores beyond their reliability level.
   *
   * - `catalog_noise_alias` contributions are capped at {@link CATALOG_NOISE_ALIAS_CAP}.
   * - `observed_query_alias` contributions are allowed but cannot override
   *   core (canonical/translation) signal matches.
   */
  private applyAliasCaps(
    signals: MatchSignalSet,
    candidate: ResolverCandidate,
  ): MatchSignalSet {
    const hasCatalogNoise = candidate.aliasMatches.some(
      (m) => m.aliasType === 'catalog_noise_alias',
    );
    const hasObservedQuery = candidate.aliasMatches.some(
      (m) => m.aliasType === 'observed_query_alias',
    );

    let aliasExactMatch = signals.aliasExactMatch;
    let aliasFuzzyMatch = signals.aliasFuzzyMatch;

    // Cap catalog_noise_alias contribution
    if (hasCatalogNoise && !this.hasCoreAliasMatch(candidate)) {
      aliasExactMatch = Math.min(aliasExactMatch, CATALOG_NOISE_ALIAS_CAP);
      aliasFuzzyMatch = Math.min(aliasFuzzyMatch, CATALOG_NOISE_ALIAS_CAP);
    }

    // observed_query_alias: allow contribution but ensure it does not
    // override canonical or translation matches by capping at the
    // canonical normalized match level when no core match is present.
    if (hasObservedQuery && !this.hasCoreAliasMatch(candidate)) {
      aliasExactMatch = Math.min(aliasExactMatch, signals.canonicalNormalizedMatch);
      aliasFuzzyMatch = Math.min(aliasFuzzyMatch, signals.canonicalNormalizedMatch);
    }

    return {
      ...signals,
      aliasExactMatch,
      aliasFuzzyMatch,
    };
  }

  /**
   * Checks whether the candidate has at least one match from a core
   * (high-trust) alias type: canonical, translation, or phonetic.
   */
  private hasCoreAliasMatch(candidate: ResolverCandidate): boolean {
    return candidate.aliasMatches.some(
      (m) =>
        m.aliasType === 'canonical' ||
        m.aliasType === 'translation' ||
        m.aliasType === 'phonetic',
    );
  }
}
