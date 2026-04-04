/**
 * Uncertainty assessment for a query plan.
 *
 * Captures the planner's estimate of how ambiguous or uncertain the query is
 * across multiple dimensions. Used by the PolicyCompiler to decide thresholds
 * and fallback strategies.
 */
export interface QueryUncertainty {
  /** Overall uncertainty score in [0, 1]. Higher means more uncertain. */
  readonly overall: number;

  /** Whether any form of ambiguity was detected. */
  readonly ambiguityDetected: boolean;

  /** Specific ambiguity types detected (e.g. "polysemous_name", "region_vs_producer"). */
  readonly ambiguityTypes: readonly string[];

  /** Severity classification of the detected ambiguity. */
  readonly ambiguitySeverity: 'low' | 'medium' | 'high';

  /**
   * What effect this uncertainty has on downstream decisions.
   * - `trace_only` -- logged but does not change behavior.
   * - `raise_threshold` -- resolution threshold T_resolve is increased.
   * - `force_clarify` -- the system must ask for clarification.
   * - `block_resolve` -- resolution is blocked entirely.
   */
  readonly decisionEffect:
    | 'trace_only'
    | 'raise_threshold'
    | 'force_clarify'
    | 'block_resolve';

  /** Confidence in [0, 1] that the query was parsed correctly. */
  readonly parserConfidence: number;

  /** Confidence in [0, 1] in the extracted anchor candidates. */
  readonly anchorConfidence: number;

  /** Confidence in [0, 1] in the extracted constraints. */
  readonly constraintConfidence: number;
}
