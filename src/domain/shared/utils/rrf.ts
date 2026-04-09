/**
 * Standard smoothing constant for Reciprocal Rank Fusion.
 *
 * k = 60 is the canonical value from Cormack et al. (2009), "Reciprocal Rank
 * Fusion outperforms Condorcet and individual Rank Learning Methods". It is
 * the default used across the retrieval pipeline unless a caller specifically
 * overrides it (e.g. channel-specific fusion tuning).
 */
export const RRF_DEFAULT_K = 60;

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
      fused.set(entityId, current + 1 / (k + rank));
    }
  }

  return fused;
}
