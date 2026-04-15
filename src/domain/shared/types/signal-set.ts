/**
 * The complete set of scoring signals computed for a candidate wine entity,
 * per RFC-000 section 6.
 *
 * All values are numeric scores, typically in [0, 1] unless otherwise noted.
 * These signals feed into the final scoring and ranking stages.
 */
export interface SignalSet {
  /** Score reflecting the integrity and completeness of the entity's data. */
  readonly entity_integrity_score: number;

  /** Binary (0 or 1) indicating whether all hard constraints are satisfied. */
  readonly hard_constraint_pass: number;

  /** Weighted score reflecting how well soft constraints are met, in [0, 1]. */
  readonly soft_constraint_score: number;

  /** Cosine or dot-product similarity from dense/semantic retrieval, in [0, 1]. */
  readonly semantic_relevance_score?: number | undefined;

  /** Score reflecting alignment with user taste preferences, in [0, 1]. */
  readonly preference_alignment_score?: number | undefined;

  /** Popularity or trending score derived from external signals, in [0, 1]. */
  readonly popularity_score?: number | undefined;

  /** Availability score (e.g. in-stock likelihood), in [0, 1]. */
  readonly availability_score?: number | undefined;

  /** Penalty applied for uncertainty in the resolution, in [0, 1]. Higher means more penalty. */
  readonly uncertainty_penalty: number;
}
