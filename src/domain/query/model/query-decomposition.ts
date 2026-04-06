/**
 * T2.4: Query Decomposition Model
 *
 * Captures how a complex query (A vs B, multi-intent, pairing)
 * should be decomposed into sub-queries for parallel execution.
 */

/**
 * Decomposition strategy — how the query is split into sub-queries.
 *
 * - 'comparison'    — "A vs B" style: two named entities to compare
 * - 'multi_intent'  — multiple independent intents in one query
 * - 'anchor_relative' — anchor + relative expression ("cheaper than X")
 * - 'pairing'       — food/occasion pairing ("wine for steak")
 * - 'none'          — no decomposition needed; single-query execution
 */
export type DecompositionStrategy =
  | 'comparison'
  | 'multi_intent'
  | 'anchor_relative'
  | 'pairing'
  | 'none';

/**
 * Hint populated by the Planner when a query should be decomposed.
 * Consumed by ExecutionCompiler and downstream routing logic.
 *
 * This is a planning hint, not a binding execution decision.
 * Execution may override (e.g. if decomposition is disabled by kill-switch).
 */
export interface QueryDecompositionHint {
  /** Which decomposition strategy applies. */
  readonly strategy: DecompositionStrategy;

  /**
   * Expected number of sub-queries after decomposition.
   * 0 means no decomposition (strategy === 'none').
   */
  readonly subQueryCount: number;

  /**
   * Confidence in the decomposition decision (0–1).
   * Below 0.5 the engine may fall back to single-query execution.
   */
  readonly confidence: number;

  /** Human-readable reason for debug/trace. */
  readonly reason?: string;
}
