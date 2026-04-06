import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';

/** Top-K final scores for entropy / abstain policy (RFC-013). */
export function topKFinalScores(
  rankedResults: readonly RankedResult[],
  k: number = 10,
): readonly number[] {
  return rankedResults.slice(0, k).map((r) => r.finalScore);
}
