/**
 * Operators supported for normalized constraints.
 */
export type ConstraintOperator = '=' | '<=' | '>=' | 'range' | 'in' | 'exclude';

/**
 * A single normalized constraint extracted from a user query.
 */
export interface NormalizedConstraint {
  /** The wine attribute being constrained (e.g. "region", "price", "grape_variety"). */
  readonly attribute: string;

  /** The comparison operator. */
  readonly operator: ConstraintOperator;

  /** The constraint value. For `range`, an object with `min`/`max`; for `in`, an array. */
  readonly value: string | number | { min: number; max: number } | ReadonlyArray<string>;

  /** The original phrase from the user query that produced this constraint. */
  readonly source_phrase: string;

  /** Confidence score in [0, 1] that this constraint was correctly extracted. */
  readonly confidence: number;

  /**
   * Version of the mapping table that produced this constraint (RFC-004, RFC-005).
   * Enables deterministic replay: same phrase + same version → same constraint.
   * Absent for constraints derived from sources without explicit versioning.
   */
  readonly mapping_version?: string | undefined;
}

/**
 * A bundle of constraints classified by rigidity.
 *
 * - `hard` — constraints that must be satisfied (filters).
 * - `soft` — constraints that should be satisfied but can be relaxed.
 * - `inferred` — constraints the system deduced from context, not explicitly stated.
 */
export interface ConstraintBundle {
  readonly hard: ReadonlyArray<NormalizedConstraint>;
  readonly soft: ReadonlyArray<NormalizedConstraint>;
  readonly inferred: ReadonlyArray<NormalizedConstraint>;
}
