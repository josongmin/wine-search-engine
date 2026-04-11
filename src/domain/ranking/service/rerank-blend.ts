import type { QueryClass } from '../../shared/types/index.js';
import { clamp01 } from '../../shared/utils/clamp.js';

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
 *
 * Conservative blend weights for an un-fine-tuned cross-encoder: the generic
 * BGE reranker should only nudge rankings until LTR learns `f24_rerank_score`.
 */
// FIXME(Epic-5): restore to RFC-017 §6.3 values (0.75 / 0.70) after LTR calibration.
// Current values are intentionally conservative (detuned post-retrieval refactor).
// RFC-017 §6.3 targets: semantic_preference → 0.75, pure_constraint → 0.70.
// Will be restored after Epic 5 LTR/reranker fine-tuning completes and calibration
// validates that the higher blend weights do not introduce regression.
const RERANK_BLEND_BY_CLASS: Readonly<Record<QueryClass, number>> = {
  // Generic BGE reranker + wine passages: keep weights low so lexical+dense scores
  // dominate unless LTR (Epic 4) learns a stronger rerank feature weight.
  semantic_preference: 0.18,
  pure_constraint: 0.12,
  comparison_query: 0.14,
  ambiguous_short_form: 0.12,
  anchored_similarity: 0.12,
  short_entity: 0.05,
  // exact_entity: fully specified lookup — BM25 + entity_integrity already rank correctly;
  // reranker adds noise (same rationale as short_entity).
  exact_entity: 0.05,
  unknown: 0.1,
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
  return RERANK_BLEND_BY_CLASS[queryClass];
}

/**
 * Multiplies the class weight by a global scale (ops tuning). Clamps product to [0, 1].
 */
export function effectiveRerankBlendWeight(
  queryClass: QueryClass,
  globalScale: number,
): number {
  const s = Number.isFinite(globalScale) ? clamp01(globalScale) : 1;
  return clamp01(rerankBlendWeight(queryClass) * s);
}
