/**
 * Reciprocal Rank Fusion (RRF) — combines multiple ranked lists into a single
 * fused score for each entity.
 *
 * For each ranking, an entity at rank r receives a score of 1 / (k + r).
 * Scores are summed across all rankings that include the entity.
 *
 * @param rankings - An array of maps, each mapping entity ID to its rank (1-based).
 * @param k - Smoothing constant to prevent overly high scores for top-ranked items. Default 60.
 * @returns A map of entity ID to fused RRF score, sorted by descending score is not guaranteed
 *          (caller should sort if needed).
 */
export function rrfFuse(
  rankings: ReadonlyArray<ReadonlyMap<string, number>>,
  k: number = 60,
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
