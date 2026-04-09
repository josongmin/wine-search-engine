/**
 * Epic-13 SOTA++ ranking metric utilities.
 *
 * Pure functions for nDCG, MRR, MAP, and alpha-nDCG (Clarke et al. 2008)
 * used to diagnose retrieval vs ranking bottlenecks in benchmark harness.
 *
 * All functions are:
 *   - Pure (no I/O, no module-level mutable state)
 *   - Null-safe (0 on empty input)
 *   - Finite-guarded on all divisions
 *
 * Binary relevance only (rel ∈ {0,1}); the benchmark uses set-valued
 * ground truth so graded relevance is out of scope.
 */

/** Default k for top-k cutoffs across the benchmark harness. */
export const DEFAULT_K = 10;

/** Default alpha for alpha-nDCG (Clarke et al. 2008, §3). */
export const DEFAULT_ALPHA = 0.5;

/**
 * Binary DCG at k: Σ rel(d_i) / log2(i + 2) for i in [0, k).
 * rel(d) = 1 if d ∈ relevant, 0 otherwise.
 */
function dcgAtK(rankedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): number {
  if (k <= 0 || rankedIds.length === 0) return 0;
  const limit = Math.min(k, rankedIds.length);
  let dcg = 0;
  for (let i = 0; i < limit; i += 1) {
    const id = rankedIds[i];
    if (id !== undefined && relevantIds.has(id)) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  return dcg;
}

/**
 * Ideal DCG at k assuming binary relevance: the best achievable DCG is
 * obtained by placing min(k, |relevant|) hits at the top ranks.
 */
function idcgAtK(relevantCount: number, k: number): number {
  if (k <= 0 || relevantCount <= 0) return 0;
  const hits = Math.min(k, relevantCount);
  let idcg = 0;
  for (let i = 0; i < hits; i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg;
}

/**
 * Normalized DCG at k with binary relevance.
 * Returns 0 when relevant set is empty or ranked list is empty.
 */
export function ndcg_at_k(
  rankedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (relevantIds.size === 0 || rankedIds.length === 0 || k <= 0) return 0;
  const dcg = dcgAtK(rankedIds, relevantIds, k);
  const idcg = idcgAtK(relevantIds.size, k);
  if (!Number.isFinite(idcg) || idcg === 0) return 0;
  const value = dcg / idcg;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Mean Reciprocal Rank for a single query: 1 / rank of first relevant doc.
 * Returns 0 if no relevant doc appears in the ranked list.
 */
export function mrr(rankedIds: readonly string[], relevantIds: ReadonlySet<string>): number {
  if (relevantIds.size === 0 || rankedIds.length === 0) return 0;
  for (let i = 0; i < rankedIds.length; i += 1) {
    const id = rankedIds[i];
    if (id !== undefined && relevantIds.has(id)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * Mean Average Precision at k (single query = Average Precision at k).
 * AP@k = (1 / min(k, |relevant|)) * Σ_{i=1..k} P(i) * rel(i)
 * where P(i) = precision at cut i.
 */
export function map_at_k(
  rankedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (relevantIds.size === 0 || rankedIds.length === 0 || k <= 0) return 0;
  const limit = Math.min(k, rankedIds.length);
  let hits = 0;
  let sumPrecision = 0;
  for (let i = 0; i < limit; i += 1) {
    const id = rankedIds[i];
    if (id !== undefined && relevantIds.has(id)) {
      hits += 1;
      sumPrecision += hits / (i + 1);
    }
  }
  const denom = Math.min(k, relevantIds.size);
  if (denom <= 0 || !Number.isFinite(denom)) return 0;
  const value = sumPrecision / denom;
  return Number.isFinite(value) ? value : 0;
}

/**
 * alpha-nDCG@k (Clarke et al. 2008, "Novelty and Diversity in IR Evaluation").
 *
 * Each document covers zero or more aspects (nuggets). Credit for seeing
 * an aspect that has already appeared `prev` times in higher ranks is
 * discounted by (1 - alpha)^prev. alpha = 0 reduces to binary nDCG over
 * unique aspect hits; alpha = 1 rewards only the first time an aspect
 * is seen.
 *
 * Ideal gain vector is computed by greedy selection: at each rank, pick
 * the next document whose remaining aspects yield the highest gain.
 * Clarke et al. show this greedy IDCG is a tight upper bound for small k.
 */
export function alpha_ndcg_at_k(
  rankedIds: readonly string[],
  aspectByDoc: ReadonlyMap<string, ReadonlySet<string>>,
  k: number,
  alpha: number,
): number {
  if (k <= 0 || rankedIds.length === 0 || aspectByDoc.size === 0) return 0;

  // Actual alpha-DCG over the given ranking.
  const limit = Math.min(k, rankedIds.length);
  const seenCount = new Map<string, number>();
  let dcg = 0;
  for (let i = 0; i < limit; i += 1) {
    const id = rankedIds[i];
    if (id === undefined) continue;
    const aspects = aspectByDoc.get(id);
    if (!aspects || aspects.size === 0) continue;
    let gain = 0;
    for (const aspect of aspects) {
      const prev = seenCount.get(aspect) ?? 0;
      gain += Math.pow(1 - alpha, prev);
      seenCount.set(aspect, prev + 1);
    }
    dcg += gain / Math.log2(i + 2);
  }

  // Ideal alpha-DCG: greedy selection over all docs with any aspect.
  const candidateIds: string[] = [];
  for (const [id, aspects] of aspectByDoc) {
    if (aspects.size > 0) candidateIds.push(id);
  }
  if (candidateIds.length === 0) return 0;

  const idealLimit = Math.min(k, candidateIds.length);
  const idealSeen = new Map<string, number>();
  const used = new Set<string>();
  let idcg = 0;
  for (let rank = 0; rank < idealLimit; rank += 1) {
    let bestId: string | undefined;
    let bestGain = -Infinity;
    for (const id of candidateIds) {
      if (used.has(id)) continue;
      const aspects = aspectByDoc.get(id);
      if (!aspects || aspects.size === 0) continue;
      let gain = 0;
      for (const aspect of aspects) {
        const prev = idealSeen.get(aspect) ?? 0;
        gain += Math.pow(1 - alpha, prev);
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestId = id;
      }
    }
    if (bestId === undefined || bestGain <= 0) break;
    used.add(bestId);
    const aspects = aspectByDoc.get(bestId);
    if (aspects) {
      for (const aspect of aspects) {
        const prev = idealSeen.get(aspect) ?? 0;
        idealSeen.set(aspect, prev + 1);
      }
    }
    idcg += bestGain / Math.log2(rank + 2);
  }

  if (!Number.isFinite(idcg) || idcg <= 0) return 0;
  const value = dcg / idcg;
  return Number.isFinite(value) ? value : 0;
}
