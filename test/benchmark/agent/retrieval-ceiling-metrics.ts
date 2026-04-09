/**
 * Epic-13 SOTA++ retrieval ceiling diagnostics.
 *
 * These metrics answer the core question of any two-stage retrieve→rank
 * pipeline: "When a query scores poorly, did we lose to retrieval (the
 * candidate pool never contained the gold docs) or to ranking (the pool
 * had them but we ordered them badly)?"
 *
 * - recall@k on the pre-ranking candidate pool = upper bound on achievable
 *   recall for any downstream ranker.
 * - oracle_ndcg@k = NDCG assuming the candidate pool is perfectly ordered.
 * - oracle_mrr    = MRR on the candidate pool ordered optimally (= 1/rank
 *   of the first relevant doc in the retrieved sequence).
 * - rankingEfficiency = achieved / oracle. 1.0 means the ranker extracted
 *   every point of nDCG the candidate pool made available.
 *
 * Binary relevance. All functions are pure and null-safe.
 */

import { DEFAULT_K, ndcg_at_k } from './ranking-metrics.js';

/** Retrieval bottleneck threshold: coverage below this = retrieval problem. */
const RETRIEVAL_COVERAGE_THRESHOLD = 0.8;

/** Ranking bottleneck threshold: efficiency below this = ranking problem. */
const RANKING_EFFICIENCY_THRESHOLD = 0.8;

export interface RetrievalCeilingMetrics {
  readonly recall_at_20: number;
  readonly recall_at_50: number;
  readonly recall_at_100: number;
  readonly oracle_ndcg_at_10: number;
  readonly oracle_mrr: number;
  readonly retrieved_count: number;
  readonly relevant_count: number;
  readonly ranked_count: number;
}

export interface RankingGapAnalysis {
  readonly oracle: number;
  readonly achieved: number;
  readonly retrievalCoverage: number;
  readonly rankingEfficiency: number;
  readonly gap: 'retrieval_bottleneck' | 'ranking_bottleneck' | 'both' | 'neither';
}

/**
 * Recall at cut k over the retrieved candidate pool.
 * |retrieved[0..k-1] ∩ relevant| / |relevant|, finite-guarded.
 */
function recallAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (relevantIds.size === 0 || retrievedIds.length === 0 || k <= 0) return 0;
  const limit = Math.min(k, retrievedIds.length);
  let hits = 0;
  for (let i = 0; i < limit; i += 1) {
    const id = retrievedIds[i];
    if (id !== undefined && relevantIds.has(id)) hits += 1;
  }
  const value = hits / relevantIds.size;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Oracle nDCG@k: best nDCG any ranker could achieve on the given candidate
 * pool. Equivalent to permuting retrievedIds so every relevant hit sits at
 * the top, then measuring nDCG@k against the full ground truth. IDCG is
 * computed against |relevant| (not |retrieved ∩ relevant|) so the ceiling
 * is penalized by missing recall — a retrieval miss caps the ceiling below
 * 1.0, which is the whole point of the diagnostic.
 */
function oracleNdcgAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): number {
  if (relevantIds.size === 0 || retrievedIds.length === 0 || k <= 0) return 0;
  // Count how many relevant docs the retrieved pool actually contains.
  const retrievedSet = new Set<string>();
  for (const id of retrievedIds) retrievedSet.add(id);
  let hitsInPool = 0;
  for (const id of relevantIds) if (retrievedSet.has(id)) hitsInPool += 1;
  if (hitsInPool === 0) return 0;

  // Perfectly ranked top-k: place min(k, hitsInPool) relevant docs at ranks 1..
  const topHits = Math.min(k, hitsInPool);
  let dcg = 0;
  for (let i = 0; i < topHits; i += 1) {
    dcg += 1 / Math.log2(i + 2);
  }
  // IDCG is computed assuming ground truth is fully available at the top.
  const idealHits = Math.min(k, relevantIds.size);
  let idcg = 0;
  for (let i = 0; i < idealHits; i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  if (!Number.isFinite(idcg) || idcg <= 0) return 0;
  const value = dcg / idcg;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Oracle MRR: reciprocal rank of the first relevant doc if the candidate
 * pool were ordered optimally. If the pool contains any relevant doc at
 * all, the oracle places it at rank 1, so the value is 1 when any hit
 * exists and 0 otherwise.
 */
function oracleMrr(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
): number {
  if (relevantIds.size === 0 || retrievedIds.length === 0) return 0;
  for (const id of retrievedIds) {
    if (relevantIds.has(id)) return 1;
  }
  return 0;
}

/**
 * Compute the full ceiling bundle for a single query.
 */
export function computeRetrievalCeiling(
  retrievedIds: readonly string[],
  rankedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
): RetrievalCeilingMetrics {
  return {
    recall_at_20: recallAtK(retrievedIds, relevantIds, 20),
    recall_at_50: recallAtK(retrievedIds, relevantIds, 50),
    recall_at_100: recallAtK(retrievedIds, relevantIds, 100),
    oracle_ndcg_at_10: oracleNdcgAtK(retrievedIds, relevantIds, DEFAULT_K),
    oracle_mrr: oracleMrr(retrievedIds, relevantIds),
    retrieved_count: retrievedIds.length,
    relevant_count: relevantIds.size,
    ranked_count: rankedIds.length,
  };
}

/**
 * Decompose a query's performance into a retrieval vs ranking gap.
 *
 * Classification:
 *   - retrievalCoverage < 0.8 AND rankingEfficiency < 0.8 → 'both'
 *   - retrievalCoverage < 0.8                              → 'retrieval_bottleneck'
 *   - rankingEfficiency < 0.8                              → 'ranking_bottleneck'
 *   - otherwise                                            → 'neither'
 *
 * retrievalCoverage = |retrieved ∩ relevant| / |relevant|, capped at 1.
 * rankingEfficiency = achieved_ndcg@k / oracle_ndcg@k (1.0 = perfect ranker).
 */
export function diagnoseRankingGap(
  retrievedIds: readonly string[],
  rankedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number = DEFAULT_K,
): RankingGapAnalysis {
  const oracle = oracleNdcgAtK(retrievedIds, relevantIds, k);
  const achieved = ndcg_at_k(rankedIds, relevantIds, k);

  let retrievalCoverage = 0;
  if (relevantIds.size > 0 && retrievedIds.length > 0) {
    const retrievedSet = new Set<string>();
    for (const id of retrievedIds) retrievedSet.add(id);
    let hits = 0;
    for (const id of relevantIds) if (retrievedSet.has(id)) hits += 1;
    const cov = hits / relevantIds.size;
    retrievalCoverage = Number.isFinite(cov) ? cov : 0;
  }

  let rankingEfficiency = 0;
  if (oracle > 0 && Number.isFinite(oracle)) {
    const eff = achieved / oracle;
    // Clamp at 1.0: floating-point noise can push ratios above 1.
    rankingEfficiency = Number.isFinite(eff) ? Math.min(1, Math.max(0, eff)) : 0;
  } else if (achieved === 0) {
    // Nothing to rank: neither bottleneck meaningful, treat as 1.
    rankingEfficiency = 1;
  }

  const retrievalBad = retrievalCoverage < RETRIEVAL_COVERAGE_THRESHOLD;
  const rankingBad = rankingEfficiency < RANKING_EFFICIENCY_THRESHOLD;
  let gap: RankingGapAnalysis['gap'];
  if (retrievalBad && rankingBad) gap = 'both';
  else if (retrievalBad) gap = 'retrieval_bottleneck';
  else if (rankingBad) gap = 'ranking_bottleneck';
  else gap = 'neither';

  return {
    oracle,
    achieved,
    retrievalCoverage,
    rankingEfficiency,
    gap,
  };
}
