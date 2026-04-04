import type { QueryClass } from '../../shared/types/index.js';

/**
 * Weight configuration for the score aggregation formula.
 *
 * Non-gate signals are normalized so their weights sum to approximately 1.0.
 * Gate signals (hard constraint pass, entity integrity threshold) are handled
 * separately as pass/fail before weighted aggregation.
 */
export interface ScoringWeights {
  /** Weight for entity integrity signal. */
  readonly entityIntegrity: number;

  /** Weight for anchor similarity signal (only meaningful for anchored queries). */
  readonly anchorSimilarity: number;

  /** Weight for semantic relevance signal. */
  readonly semantic: number;

  /** Weight for soft constraint satisfaction. */
  readonly softConstraint: number;

  /** Weight for structured attribute alignment. */
  readonly attributeAlignment: number;

  /** Weight for user preference alignment. */
  readonly preferenceAlignment: number;

  /** Weight for popularity signal (intentionally small — tie-breaker level). */
  readonly popularity: number;

  /** Weight for availability signal. */
  readonly availability: number;

  /** Weight for uncertainty penalty (applied as subtraction). */
  readonly uncertaintyPenalty: number;

  /**
   * Minimum entity integrity score below which the candidate is removed.
   * Acts as a gate similar to hard constraints.
   */
  readonly entityIntegrityThreshold: number;
}

/**
 * Default scoring weights for general queries.
 * Weights for non-gate signals sum to ~1.0.
 */
const DEFAULT_WEIGHTS: ScoringWeights = {
  entityIntegrity: 0.15,
  anchorSimilarity: 0.0,
  semantic: 0.25,
  softConstraint: 0.20,
  attributeAlignment: 0.15,
  preferenceAlignment: 0.10,
  popularity: 0.03,
  availability: 0.07,
  uncertaintyPenalty: 0.05,
  entityIntegrityThreshold: 0.3,
} as const;

/**
 * Query-class-specific weight overrides.
 *
 * Each override is a partial set of weights that will be merged with
 * {@link DEFAULT_WEIGHTS}. For example, `anchored_similarity` raises the
 * anchor weight and lowers semantic weight to prevent embedding similarity
 * from dominating (RFC-013 rule 5).
 */
const QUERY_CLASS_OVERRIDES: Readonly<Partial<Record<QueryClass, Partial<ScoringWeights>>>> = {
  anchored_similarity: {
    anchorSimilarity: 0.30,
    semantic: 0.10,
    softConstraint: 0.15,
    attributeAlignment: 0.10,
    preferenceAlignment: 0.10,
    entityIntegrity: 0.10,
    popularity: 0.02,
    availability: 0.08,
    uncertaintyPenalty: 0.05,
  },
  pure_constraint: {
    softConstraint: 0.30,
    attributeAlignment: 0.25,
    semantic: 0.10,
    entityIntegrity: 0.10,
    preferenceAlignment: 0.10,
    popularity: 0.03,
    availability: 0.07,
    uncertaintyPenalty: 0.05,
  },
  semantic_preference: {
    semantic: 0.30,
    preferenceAlignment: 0.25,
    softConstraint: 0.10,
    attributeAlignment: 0.10,
    entityIntegrity: 0.10,
    popularity: 0.03,
    availability: 0.07,
    uncertaintyPenalty: 0.05,
  },
  short_entity: {
    entityIntegrity: 0.30,
    attributeAlignment: 0.25,
    semantic: 0.15,
    softConstraint: 0.10,
    preferenceAlignment: 0.05,
    popularity: 0.03,
    availability: 0.07,
    uncertaintyPenalty: 0.05,
  },
  ambiguous_short_form: {
    entityIntegrity: 0.25,
    semantic: 0.20,
    attributeAlignment: 0.20,
    softConstraint: 0.10,
    preferenceAlignment: 0.05,
    popularity: 0.03,
    availability: 0.07,
    uncertaintyPenalty: 0.10,
  },
  comparison_query: {
    entityIntegrity: 0.20,
    attributeAlignment: 0.20,
    semantic: 0.20,
    softConstraint: 0.15,
    preferenceAlignment: 0.05,
    popularity: 0.03,
    availability: 0.07,
    uncertaintyPenalty: 0.10,
  },
} as const;

/**
 * Resolves the effective scoring weights for a given query class.
 *
 * Merges query-class-specific overrides on top of the default weights.
 * If no override exists for the given class, the defaults are returned as-is.
 *
 * @param queryClass - The query classification label.
 * @returns The resolved scoring weights.
 */
export function resolveWeights(queryClass: QueryClass): ScoringWeights {
  const overrides = QUERY_CLASS_OVERRIDES[queryClass];
  if (overrides === undefined) {
    return DEFAULT_WEIGHTS;
  }
  return { ...DEFAULT_WEIGHTS, ...overrides };
}

export { DEFAULT_WEIGHTS };
