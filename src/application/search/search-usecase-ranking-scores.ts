import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';

/** Top-K final scores for entropy / abstain policy (RFC-013).
 *  Non-finite values (NaN, ±Infinity) are excluded to prevent
 *  downstream entropy calculations from producing garbage. */
export function topKFinalScores(
  rankedResults: readonly RankedResult[],
  k: number = 10,
): readonly number[] {
  return rankedResults
    .slice(0, k)
    .map((r) => r.finalScore)
    .filter(Number.isFinite);
}
