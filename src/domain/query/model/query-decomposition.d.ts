/**
 * T2.4: Query Decomposition Model
 *
 * Captures how a complex query (A vs B, multi-intent, pairing)
 * should be decomposed into sub-queries for parallel execution.
 */
export type DecompositionStrategy = 'comparison' | 'multi_intent' | 'anchor_relative' | 'pairing' | 'none';
export type ComparisonIntent = 'compare' | 'recommend_one' | 'list_both';
export type ComparisonDecompositionSubtype = 'entity' | 'concept' | 'mixed';
export type ComparisonLegMode = 'entity' | 'concept';
export type ComparisonLegRetrievalMode = 'auto' | 'entity' | 'hybrid';
export type ComparisonLegEvidenceSource = 'direct_entity_resolution' | 'span_entity_resolution' | 'entity_default';
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
    ComparisonDecompositionLeg
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
export declare function buildEntityComparisonLegs(subQueries: readonly [string, string]): ComparisonDecompositionLegs;
export declare function buildEntityComparisonLeg(rawQuery: string): ComparisonDecompositionLeg;
export declare function getComparisonDecompositionSubtype(legs: ComparisonDecompositionLegs): ComparisonDecompositionSubtype;
export declare function toQueryDecompositionHint(outcome: DetectableDecompositionOutcome): QueryDecompositionHint;
export {};
//# sourceMappingURL=query-decomposition.d.ts.map