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
  const fused = new Map<string, number>();

  for (const ranking of rankings) {
    for (const [entityId, rank] of ranking) {
      const current = fused.get(entityId) ?? 0;
      fused.set(entityId, current + 1 / (k + rank));
    }
  }

  return fused;
}
