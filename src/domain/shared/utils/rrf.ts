/**
 * RRF K constants — single source of truth for every Reciprocal Rank Fusion
 * smoothing constant used across the retrieval pipeline. Rule 30 SSoT:
 * any caller that needs an RRF K MUST import from here (no private literals).
 *
 * Intuition:
 *   - Lower K → exact / known-item bias. The rank-1 hit dominates because
 *     `1/(k+1)` and `1/(k+2)` diverge sharply when k is small. Use this when
 *     a single resolved entity (anchor, exact title match) should drive the
 *     fused ranking.
 *   - Higher K → diversity / browse bias. `1/(k+r)` flattens across r, so
 *     long-tail hits retain more weight. Use this when the user is exploring
 *     (pairing, semantic browse) and recall matters more than rank precision.
 *
 * Quantitative reference (rank-1 vs rank-10 score ratio):
 *   k=10  → 1/11  ÷ 1/20  ≈ 1.82  (rank-1 carries 82% more weight)
 *   k=30  → 1/31  ÷ 1/40  ≈ 1.29
 *   k=40  → 1/41  ÷ 1/50  ≈ 1.22
 *   k=60  → 1/61  ÷ 1/70  ≈ 1.15  (Cormack 2009 canonical)
 *   k=80  → 1/81  ÷ 1/90  ≈ 1.11  (flattest — pairing tail kept alive)
 */
export const RRF_K = {
  /**
   * ENTITY_EXACT (k=10) — anchor-first lookups where the planner resolved a
   * single entity with high confidence. Maximize separation between the
   * resolved anchor and tail candidates so the anchor wins the fusion output.
   */
  ENTITY_EXACT: 10,
  /**
   * TIGHT (k=30) — specific_wine / known-cuvée lookups. Rank-1 sparse hit
   * should dominate the fused score without crushing rank 2-3 entirely.
   */
  TIGHT: 30,
  /**
   * COMPARE (k=40) — "X vs Y" flows where both anchors must appear and rank
   * order remains meaningful for the side-by-side response.
   */
  COMPARE: 40,
  /**
   * DEFAULT (k=60) — Cormack et al. (2009) canonical value. The generic
   * hybrid retrieval default unless a caller has class-specific tuning.
   */
  DEFAULT: 60,
  /**
   * LOOSE (k=80) — browse / food-pairing flows. Long-tail candidates carry
   * real recall value; flatter rank weights preserve diversity.
   */
  LOOSE: 80,
} as const satisfies Readonly<Record<string, number>>;

/**
 * Backward-compatible alias. The canonical Cormack et al. (2009) k=60 default
 * used across the retrieval pipeline unless a caller specifically overrides it
 * (e.g. channel-specific fusion tuning via {@link RRF_K}).
 */
export const RRF_DEFAULT_K = RRF_K.DEFAULT;

/**
 * Single-rank RRF contribution: `1 / (k + rank)`.
 *
 * Shared by all retrieval channels that need to score an individual hit's
 * contribution without running a full fusion pass (e.g. anchor-similarity
 * dense retrieval, candidate-pool per-channel provenance scores).
 *
 * Invariants (matching {@link rrfFuse}):
 *  - `k` must be ≥ 1. k < 1 produces negative or divergent scores.
 *  - `rank` must be a positive finite integer (1-based). Non-finite or
 *    non-positive ranks return 0 (defensive — callers feeding upstream
 *    data should not crash the pipeline on one malformed record).
 *
 * @param rank - 1-based rank of the entity within a ranking.
 * @param k - Smoothing constant. Defaults to {@link RRF_DEFAULT_K}.
 * @returns The RRF contribution for this single (rank, k) pair.
 */
export function rrfContribution(rank: number, k: number = RRF_DEFAULT_K): number {
  if (k < 1) {
    throw new Error(`rrfContribution: k must be ≥ 1, got ${k}`);
  }
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  return 1 / (k + rank);
}

/**
 * Reciprocal Rank Fusion (RRF) — combines multiple ranked lists into a single
 * fused score for each entity.
 *
 * For each ranking, an entity at rank r receives a score of 1 / (k + r).
 * Scores are summed across all rankings that include the entity.
 *
 * @param rankings - An array of maps, each mapping entity ID to its rank (1-based).
 * @param k - Smoothing constant to prevent overly high scores for top-ranked items. Default {@link RRF_DEFAULT_K}.
 * @returns A map of entity ID to fused RRF score, sorted by descending score is not guaranteed
 *          (caller should sort if needed).
 */
export function rrfFuse(
  rankings: ReadonlyArray<ReadonlyMap<string, number>>,
  k: number = RRF_DEFAULT_K,
): Map<string, number> {
  // k must be ≥ 1. k=0 with rank=1 gives 1/1 = 1.0 (diverges from the
  // smoothing intent), and k<0 produces negative scores for high ranks,
  // inverting the entire ranking. Guard here as the authoritative
  // low-level function so all callers are protected.
  if (k < 1) {
    throw new Error(`rrfFuse: k must be ≥ 1, got ${k}`);
  }

  const fused = new Map<string, number>();

  for (const ranking of rankings) {
    for (const [entityId, rank] of ranking) {
      // rank must be a positive integer (1-based). A rank of 0 or negative
      // would make 1/(k+rank) produce Infinity (when rank == -k) or a
      // negative score (when rank < -k), corrupting the fused ranking.
      // Skip such entries defensively rather than propagating bad values.
      if (rank <= 0) continue;
      const current = fused.get(entityId) ?? 0;
      fused.set(entityId, current + rrfContribution(rank, k));
    }
  }

  return fused;
}
