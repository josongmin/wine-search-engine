/**
 * T5.6: Funnel-level aggregate metrics computation.
 *
 * Derives five explainability signals from the completed ranking funnel:
 *   1. coarsePrunePassRate  — fraction of candidates surviving coarse prune
 *   2. rerankChangedTopK    — whether precision rerank reordered the top-5
 *   3. meanFinalScore       — mean final score of retained candidates
 *   4. scoreGapRank1Rank2   — score gap between #1 and #2 (confidence proxy)
 *   5. producerDiversity    — count of distinct producers in the final set
 *
 * None of these metrics alter ranking behaviour; they are pure read-only
 * observability signals attached to {@link RankingFunnelTrace.metrics}.
 */

import type { FunnelMetrics, RankingFunnelTrace } from '../model/ranking-stage.js';
import type { RankedResult } from '../model/ranked-result.js';

/**
 * Compute funnel-level aggregate metrics from the completed funnel trace
 * and the final ranked result list.
 *
 * @param funnelTrace - The completed ranking funnel trace (stages + flags).
 * @param results - The final ordered ranked results produced by the pipeline.
 * @param preRerankTop5EntityIds - Optional snapshot of the top-5 entityIds
 *   recorded immediately after primary_rank, before precision rerank runs.
 *   Required to determine whether reranking changed the top-5 order.
 *   When omitted (or when rerank was not executed), `rerankChangedTopK`
 *   is always `false`.
 * @returns A {@link FunnelMetrics} object suitable for attachment to
 *   {@link RankingFunnelTrace.metrics}.
 */
export function computeFunnelMetrics(
  funnelTrace: RankingFunnelTrace,
  results: readonly RankedResult[],
  preRerankTop5EntityIds?: readonly string[],
): FunnelMetrics {
  // ── 1. coarsePrunePassRate ────────────────────────────────────────────────
  // Derived from the coarse_prune stage trace: outputCount / inputCount.
  // If no coarse_prune stage is present or input was zero, we fall back to 1.0
  // (treat all candidates as retained — no information loss).
  const pruneStage = funnelTrace.stages.find((s) => s.stage === 'coarse_prune');
  const coarsePrunePassRate =
    pruneStage !== undefined && pruneStage.inputCount > 0
      ? pruneStage.outputCount / pruneStage.inputCount
      : 1.0;

  // ── 2. rerankChangedTopK ──────────────────────────────────────────────────
  // Compare the pre-rerank top-5 entity IDs snapshot with the post-rerank
  // top-5 of the final results. Only meaningful when rerank actually executed.
  let rerankChangedTopK = false;
  if (
    funnelTrace.precisionRerankExecuted &&
    preRerankTop5EntityIds !== undefined &&
    preRerankTop5EntityIds.length > 0
  ) {
    const postRerankTop5 = results
      .slice(0, 5)
      .map((r) => String(r.entityId));

    const preSlice = preRerankTop5EntityIds.slice(0, 5);

    // Changed if lengths differ or any position differs
    if (preSlice.length !== postRerankTop5.length) {
      rerankChangedTopK = true;
    } else {
      rerankChangedTopK = preSlice.some(
        (id, idx) => id !== postRerankTop5[idx],
      );
    }
  }

  // ── 3. meanFinalScore ─────────────────────────────────────────────────────
  // Arithmetic mean of the finalScore for all results. Zero when empty.
  const meanFinalScore =
    results.length === 0
      ? 0
      : results.reduce((sum, r) => sum + r.finalScore, 0) / results.length;

  // ── 4. scoreGapRank1Rank2 ─────────────────────────────────────────────────
  // Difference between the top-ranked and second-ranked final scores.
  // Null when fewer than 2 results are present (gap is undefined).
  const scoreGapRank1Rank2: number | null =
    results.length >= 2
      ? (results[0]?.finalScore ?? 0) - (results[1]?.finalScore ?? 0)
      : null;

  // ── 5. producerDiversity ─────────────────────────────────────────────────
  // Count of distinct non-empty producer names in the final result set.
  const producerSet = new Set<string>();
  for (const result of results) {
    if (result.producer !== undefined && result.producer.trim().length > 0) {
      producerSet.add(result.producer.trim());
    }
  }
  const producerDiversity = producerSet.size;

  return {
    coarsePrunePassRate,
    rerankChangedTopK,
    meanFinalScore,
    scoreGapRank1Rank2,
    producerDiversity,
  };
}
