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

export type ComparisonIntent = 'compare' | 'recommend_one' | 'list_both';

export type ComparisonDecompositionSubtype = 'entity' | 'concept' | 'mixed';

export type ComparisonLegMode = 'entity' | 'concept';

export type ComparisonLegRetrievalMode = 'auto' | 'entity' | 'hybrid';

export type ComparisonLegEvidenceSource =
  | 'direct_entity_resolution'
  | 'span_entity_resolution'
  | 'entity_default';

export interface ComparisonDecompositionLeg {
  readonly rawQuery: string;
  readonly retrievalQuery: string;
  readonly mode: ComparisonLegMode;
  readonly retrievalMode: ComparisonLegRetrievalMode;
  readonly evidenceSource: ComparisonLegEvidenceSource;
  readonly conceptEntityType?: 'country' | 'region' | 'appellation' | 'grape_primary' | 'wine_type' | undefined;
  readonly canonicalConcept?: string | undefined;
}

export type ComparisonDecompositionLegs = readonly [
  ComparisonDecompositionLeg,
  ComparisonDecompositionLeg,
];

export interface QueryDecompositionHint {
  readonly strategy: DecompositionStrategy;
  readonly subQueryCount: number;
  readonly confidence: number;
  readonly reason?: string;
  readonly comparisonSubtype?: ComparisonDecompositionSubtype | undefined;
  readonly comparisonLegs?: ComparisonDecompositionLegs | undefined;
}

interface DetectableDecompositionOutcome {
  readonly decomposed: boolean;
  readonly subQueries?: readonly [string, string] | undefined;
  readonly comparisonIntent?: ComparisonIntent | undefined;
  readonly comparisonSubtype?: ComparisonDecompositionSubtype | undefined;
  readonly comparisonLegs?: ComparisonDecompositionLegs | undefined;
}

/** Confidence when both comparison sub-queries are non-empty. */
const DECOMPOSITION_CONFIDENCE_FULL_PAIR = 0.9;
/** Confidence when only one side parsed (partial decomposition). */
const DECOMPOSITION_CONFIDENCE_PARTIAL = 0.4;

export function buildEntityComparisonLegs(
  subQueries: readonly [string, string],
): ComparisonDecompositionLegs {
  return [
    buildEntityComparisonLeg(subQueries[0]),
    buildEntityComparisonLeg(subQueries[1]),
  ];
}

export function buildEntityComparisonLeg(rawQuery: string): ComparisonDecompositionLeg {
  return {
    rawQuery,
    retrievalQuery: rawQuery,
    mode: 'entity',
    retrievalMode: 'auto',
    evidenceSource: 'entity_default',
  };
}

export function getComparisonDecompositionSubtype(
  legs: ComparisonDecompositionLegs,
): ComparisonDecompositionSubtype {
  const [left, right] = legs;
  if (left.mode === 'concept' && right.mode === 'concept') {
    return 'concept';
  }
  if (left.mode === 'entity' && right.mode === 'entity') {
    return 'entity';
  }
  return 'mixed';
}

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

  const hint: QueryDecompositionHint = {
    strategy,
    subQueryCount: nonEmptyCount,
    confidence: nonEmptyCount === 2 ? DECOMPOSITION_CONFIDENCE_FULL_PAIR : DECOMPOSITION_CONFIDENCE_PARTIAL,
    reason:
      outcome.comparisonIntent !== undefined
        ? `comparison:${outcome.comparisonIntent}`
        : 'generic_multi_intent',
  };

  if (outcome.comparisonSubtype !== undefined || outcome.comparisonLegs !== undefined) {
    return {
      ...hint,
      ...(outcome.comparisonSubtype !== undefined
        ? { comparisonSubtype: outcome.comparisonSubtype }
        : {}),
      ...(outcome.comparisonLegs !== undefined
        ? { comparisonLegs: outcome.comparisonLegs }
        : {}),
    };
  }

  return hint;
}
