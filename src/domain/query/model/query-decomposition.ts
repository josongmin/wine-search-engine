/**
 * T2.4: Query Decomposition Model
 *
 * Captures how a complex query (A vs B, multi-intent, pairing)
 * should be decomposed into sub-queries for parallel execution.
 */

export type DecompositionStrategy =
  | 'comparison'
  | 'multi_intent'
  | 'anchor_relative'
  | 'pairing'
  | 'none';

export interface QueryDecompositionHint {
  readonly strategy: DecompositionStrategy;
  readonly subQueryCount: number;
  readonly confidence: number;
  readonly reason?: string;
}

export interface DetectableDecompositionOutcome {
  readonly decomposed: boolean;
  readonly subQueries?: readonly [string, string] | undefined;
  readonly comparisonIntent?: 'compare' | 'recommend_one' | 'list_both' | undefined;
}

/** Confidence when both comparison sub-queries are non-empty. */
const DECOMPOSITION_CONFIDENCE_FULL_PAIR = 0.9;
/** Confidence when only one side parsed (partial decomposition). */
const DECOMPOSITION_CONFIDENCE_PARTIAL = 0.4;

export function toQueryDecompositionHint(
  outcome: DetectableDecompositionOutcome,
): QueryDecompositionHint {
  if (!outcome.decomposed) {
    return {
      strategy: 'none',
      subQueryCount: 0,
      confidence: 0,
      reason: 'no_decomposition_detected',
    };
  }

  const [left, right] = outcome.subQueries ?? ['', ''];
  const nonEmptyCount = [left, right].filter((value) => value.trim().length > 0).length;
  const strategy =
    outcome.comparisonIntent !== undefined ? 'comparison' : 'multi_intent';

  return {
    strategy,
    subQueryCount: nonEmptyCount,
    confidence: nonEmptyCount === 2 ? DECOMPOSITION_CONFIDENCE_FULL_PAIR : DECOMPOSITION_CONFIDENCE_PARTIAL,
    reason:
      outcome.comparisonIntent !== undefined
        ? `comparison:${outcome.comparisonIntent}`
        : 'generic_multi_intent',
  };
}
