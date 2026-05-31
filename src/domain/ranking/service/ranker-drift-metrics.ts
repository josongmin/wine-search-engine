import type { RankedResult } from '../model/ranked-result.js';
import type { SafetyCandidateDescriptor } from './rerank-safety.js';

// ─── E5-T6: ScoreDriftRecord helpers ─────────────────────────────────────────

/**
 * E5-T6: Top-K window for ScoreDriftRecord heuristic/LTR top-N comparison.
 * Must match ScoreDriftRecord.heuristicTop3EntityIds field semantics (top-3).
 */
export const DRIFT_MONITOR_TOP_K = 3;

/**
 * Compute normalized Kendall tau distance between two entity-ID orderings.
 *
 * Returns a value in [0, 1]:
 *   0 = identical order
 *   1 = completely reversed
 *
 * Only entities present in BOTH lists are compared; entities unique to one
 * list are ignored (avoids penalizing safety-evicted candidates).
 *
 * Time: O(n²) where n = common list length (typically ≤ 3).
 */
export function computeKendallTauDistance(
  listA: readonly string[],
  listB: readonly string[],
): number {
  // Build intersection in listA order
  const setB = new Set(listB);
  const common = listA.filter((id) => setB.has(id));
  const n = common.length;
  if (n < 2) return 0;

  // For each id in common, record its position in listB
  const posB = new Map<string, number>(listB.map((id, i) => [id, i]));

  let discordant = 0;
  const totalPairs = (n * (n - 1)) / 2;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const rankBi = posB.get(common[i]!) ?? Infinity;
      const rankBj = posB.get(common[j]!) ?? Infinity;
      // In listA: i < j (i ranks higher). In listB: discordant if j ranks higher than i.
      if (rankBj < rankBi) {
        discordant++;
      }
    }
  }

  return totalPairs > 0 ? discordant / totalPairs : 0;
}

/**
 * Compute mean absolute normalized score delta across reranked candidates.
 *
 * Compares each candidate's heuristic score (from safetyDescriptors) to
 * the LTR finalScore (from ltrResults). Candidates missing from either
 * side are skipped.
 */
export function computeAverageRerankDelta(
  safetyDescriptors: readonly SafetyCandidateDescriptor[],
  ltrResults: readonly RankedResult[],
): number {
  const heuristicScoreMap = new Map<string, number>(
    safetyDescriptors.map((d) => [d.entityId, d.heuristicScoreNormalized]),
  );

  let totalDelta = 0;
  let count = 0;
  for (const r of ltrResults) {
    const id = String(r.entityId);
    const heuristicScore = heuristicScoreMap.get(id);
    if (heuristicScore === undefined) continue;
    const ltrScore = Number.isFinite(r.finalScore) ? r.finalScore : 0;
    totalDelta += Math.abs(ltrScore - heuristicScore);
    count++;
  }

  return count > 0 ? totalDelta / count : 0;
}
