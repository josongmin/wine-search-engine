import type { QueryClass } from '../../shared/types/index.js';
import { clamp01 } from '../../shared/utils/clamp.js';

/**
 * Query-class-aware reranker blend weights (RFC-017 §5.3 / §6.3).
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
 * ──────────────────────────────────────────────────────────────────────
 * Two weight sets are maintained as a gated A/B framework:
 *
 *   1. RERANK_BLEND_DETUNED  — production default. Conservative values used
 *      since the post-retrieval refactor; the generic BGE reranker should
 *      only nudge rankings until LTR learns `f24_rerank_score`.
 *
 *   2. RERANK_BLEND_EPIC5    — RFC-017 §6.3 target values. Activated only
 *      after LTR calibration validates that the higher blend weights do not
 *      introduce regression. Selected at runtime via the
 *      `RERANK_BLEND_EPIC5_RESTORE` env flag.
 *
 * Default remains DETUNED so production behaviour is unchanged. The EPIC5
 * map is opt-in; once LTR/reranker fine-tuning lands and bench validates
 * the lift, ops flips the flag to compare both regimes A/B.
 * ──────────────────────────────────────────────────────────────────────
 */

/**
 * Conservative blend weights for an un-fine-tuned cross-encoder.
 * These are the production defaults that have shipped since the
 * post-retrieval refactor — preserving them as the OFF state of the
 * feature flag guarantees zero behaviour drift when the flag is unset.
 */
const RERANK_BLEND_DETUNED: Readonly<Record<QueryClass, number>> = Object.freeze({
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
});

/**
 * RFC-017 §6.3 target weights (Epic-5 restore).
 *
 * Source values (RFC-017 §6.3):
 *   - semantic_preference  → 0.75  ("reranker 효과 극대화 구간")
 *   - pure_constraint      → 0.70  ("constraint-aware reranking 유효")
 *   - comparison_query     → 0.65  ("passage 비교에 cross-encoder 유효")
 *   - ambiguous_short_form → 0.65  ("reranker가 disambiguation에 기여")
 *   - anchored_similarity  → 0.60  ("anchor context 활용")
 *   - short_entity         → 0.40  ("BM25 + entity_integrity 압도적, 보조만")
 *
 * `exact_entity` and `unknown` are NOT specified by RFC-017 §6.3 — we keep
 * them at the DETUNED values intentionally (documented in the comment
 * below) rather than scaling them up to a guessed ratio.
 */
const RERANK_BLEND_EPIC5: Readonly<Record<QueryClass, number>> = Object.freeze({
  semantic_preference: 0.75,
  pure_constraint: 0.70,
  comparison_query: 0.65,
  ambiguous_short_form: 0.65,
  anchored_similarity: 0.60,
  short_entity: 0.40,
  // exact_entity / unknown: RFC-017 §6.3 does not specify values.
  // Hold at DETUNED to avoid speculative scale-up — these classes already
  // rank correctly via BM25 + entity_integrity, so the rerank blend should
  // remain a small nudge regardless of the LTR-calibration state.
  exact_entity: 0.05,
  unknown: 0.1,
});

/**
 * Returns the active blend-weight map according to the injected Epic-5 flag.
 *
 * The flag is resolved at the composition root from the validated env schema
 * (`RERANK_BLEND_EPIC5_RESTORE`) and threaded down as a plain boolean — domain
 * code MUST NOT read `process.env` directly (layer rule: domain has no infra/
 * config dependency, and the value must flow through Zod validation).
 *
 * Exported (and named, not inlined) so:
 *   - regression tests can assert both regimes deterministically,
 *   - ops can log the active regime in pipeline-debug,
 *   - downstream code never needs a second flag read.
 *
 * @param epic5Restore - When true, return the RFC-017 §6.3 EPIC5 target weights;
 *   when false (default), the DETUNED production weights.
 */
export function getRerankBlendWeights(
  epic5Restore: boolean,
): Readonly<Record<QueryClass, number>> {
  return epic5Restore ? RERANK_BLEND_EPIC5 : RERANK_BLEND_DETUNED;
}

/**
 * Returns the blend weight for the reranker score given a query class.
 *
 * The final score is computed as:
 *   `weight * rerankerScore + (1 - weight) * aggregatedScore`
 *
 * @param queryClass - The classified query type.
 * @param epic5Restore - Active blend-table regime (see {@link getRerankBlendWeights}).
 * @returns Blend weight in [0, 1] for the reranker score component.
 */
function rerankBlendWeight(queryClass: QueryClass, epic5Restore: boolean): number {
  return getRerankBlendWeights(epic5Restore)[queryClass];
}

/**
 * Multiplies the class weight by a global scale (ops tuning). Clamps product to [0, 1].
 *
 * @param queryClass - The classified query type.
 * @param globalScale - Ops blend-scale multiplier (`RERANK_BLEND_SCALE`).
 * @param epic5Restore - Active blend-table regime (see {@link getRerankBlendWeights}).
 */
export function effectiveRerankBlendWeight(
  queryClass: QueryClass,
  globalScale: number,
  epic5Restore: boolean,
): number {
  const s = Number.isFinite(globalScale) ? clamp01(globalScale) : 1;
  return clamp01(rerankBlendWeight(queryClass, epic5Restore) * s);
}

// Test-only exports (leading double-underscore signals intent).
// Production code MUST go through `getRerankBlendWeights` or
// `effectiveRerankBlendWeight`.
export {
  RERANK_BLEND_DETUNED as __RERANK_BLEND_DETUNED,
  RERANK_BLEND_EPIC5 as __RERANK_BLEND_EPIC5,
};
