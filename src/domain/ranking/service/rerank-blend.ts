import type { QueryClass } from '../../shared/types/index.js';

/**
 * Query-class-aware reranker blend weights (RFC-017 §5.3).
 *
 * The cross-encoder reranker is most effective for semantic queries where
 * BM25 is insufficient.  For exact-entity and short-entity queries, BM25 +
 * entity_integrity already rank the correct answer first; applying a high
 * reranker weight risks introducing noise from the cross-encoder's semantic
 * scoring.
 *
 * Once LambdaMART (Epic 4) is deployed, `f24_rerank_score` becomes a learned
 * LTR feature and these class-based weights are no longer needed — the model
 * will learn the optimal weighting from data.  Until then, this table provides
 * a principled, data-driven substitute for the previous hardcoded 0.6.
 */
const RERANK_BLEND_BY_CLASS: Readonly<Record<QueryClass, number>> = {
  semantic_preference: 0.75,  // reranker maximally useful; semantic similarity dominates
  pure_constraint: 0.70,      // constraint-aware passage scoring effective
  comparison_query: 0.65,     // cross-encoder good for comparing entity passages
  ambiguous_short_form: 0.65, // reranker aids disambiguation between confusables
  anchored_similarity: 0.60,  // anchor context helps cross-encoder
  short_entity: 0.40,         // BM25 + entity_integrity dominant; reranker is auxiliary
  unknown: 0.50,              // neutral: insufficient signal to weight either way
};

/**
 * Returns the blend weight for the reranker score given a query class.
 *
 * The final score is computed as:
 *   `weight * rerankerScore + (1 - weight) * aggregatedScore`
 *
 * @param queryClass - The classified query type.
 * @returns Blend weight in [0, 1] for the reranker score component.
 */
export function rerankBlendWeight(queryClass: QueryClass): number {
  return RERANK_BLEND_BY_CLASS[queryClass] ?? 0.55;
}
