export type {
  NormalizedConstraint,
  ConstraintBundle,
  ConstraintOperator,
} from '../../shared/types/index.js';

/**
 * Result of evaluating a {@link ConstraintBundle} against a candidate's
 * {@link AttributeSpace}.
 */
export interface ConstraintEvaluationResult {
  /**
   * Whether all hard constraints are satisfied.
   * If `false`, the candidate should be filtered out.
   */
  readonly hardPass: boolean;
  /**
   * Penalty-based soft score in [0, 1].
   * 1.0 means all soft constraints fully satisfied; lower values indicate
   * increasing deviation.
   */
  readonly softScore: number;
  /** Attribute names whose constraints were matched. */
  readonly matched: readonly string[];
  /** Attribute names whose constraints were NOT met. */
  readonly unmet: readonly string[];
  /** Attribute names that were system-inferred (not user-stated). */
  readonly inferred: readonly string[];
}
