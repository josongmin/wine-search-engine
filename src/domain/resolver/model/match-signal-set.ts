/**
 * The full set of match signals computed for a single candidate entity
 * during entity resolution, per RFC-006 §5.
 *
 * Each signal is a normalized score in [0, 1] unless otherwise noted.
 * These signals feed into the weighted scoring function in {@link CandidateScorer}.
 */
export interface MatchSignalSet {
  /** 1.0 when the query exactly matches the canonical entity name. */
  readonly canonicalExactMatch: number;

  /** Score for normalized (lowercased, accent-stripped) canonical match. */
  readonly canonicalNormalizedMatch: number;

  /** 1.0 when the query exactly matches a known alias. */
  readonly aliasExactMatch: number;

  /** Fuzzy alias match score (Levenshtein-based similarity). */
  readonly aliasFuzzyMatch: number;

  /** Prior weight derived from the alias type (canonical > translation > ...). */
  readonly aliasTypePrior: number;

  /** Score indicating a producer/winery name match. */
  readonly producerMatch: number;

  /** Score indicating a vintage year match. */
  readonly vintageMatch: number;

  /** Score indicating a region/appellation match. */
  readonly regionMatch: number;

  /** Score indicating a grape variety hint match. */
  readonly grapeHintMatch: number;

  /** Score from phonetic similarity (consonant-skeleton or Metaphone). */
  readonly phoneticMatch: number;

  /** Normalized edit-distance similarity score. */
  readonly editDistanceScore: number;

  /** Penalty applied when the candidate is involved in alias collisions. Non-negative. */
  readonly ambiguityPenalty: number;
}
