/**
 * Position swap pair detector (Epic-13 T13-10).
 *
 * For pairwise LLM judges, the same pair (itemA, itemB) should produce
 * consistent winners regardless of which item is shown first. When a judge's
 * preference flips with position, we have evidence of position bias and the
 * judgment is unreliable.
 *
 * Reference: Zheng et al. 2023 "Judging LLM-as-a-Judge" — position bias
 * countermeasure via swap-position consistency.
 */

import type { JudgeSample } from './judge-bias-correction.js';

/**
 * Decision boundary between "preferred" and "not preferred" judgments.
 * Pairwise judges score in [0, 1]; > 0.5 means item-at-position-A wins.
 * Use 0.5 instead of any other midpoint to keep the binary preference
 * consistent with the judge's score scale.
 */
const PREFERENCE_BOUNDARY = 0.5;
/**
 * Minimum gap between mean scores at the two positions to consider the
 * inconsistency meaningful. Prevents tiny numerical drift (0.501 vs 0.499)
 * from being flagged as position bias.
 */
const POSITION_BIAS_NOISE_FLOOR = 0.05;

export interface PositionSwapPair {
  readonly itemA: string;
  readonly itemB: string;
  readonly scoreAtA: number;
  readonly scoreAtB: number;
  /** True when the judge's preference flips between positions. */
  readonly inconsistent: boolean;
}

/**
 * Detect pairs where the same items were judged at both positions.
 * Returns one entry per (itemA, itemB) unordered pair where both positions
 * have at least one sample.
 */
export function detectPositionSwapPairs(samples: readonly JudgeSample[]): readonly PositionSwapPair[] {
  // Group by unordered pair of items.
  const groups = new Map<string, { atA: JudgeSample[]; atB: JudgeSample[]; itemA: string; itemB: string }>();
  for (const s of samples) {
    if (s.itemB === undefined) continue;
    if (s.position === undefined) continue;
    if (!Number.isFinite(s.score)) continue;
    // Canonicalize the pair key so (X, Y) and (Y, X) collide.
    const [low, high] = s.itemA < s.itemB ? [s.itemA, s.itemB] : [s.itemB, s.itemA];
    const key = `${low}\u0000${high}`;
    let entry = groups.get(key);
    if (entry === undefined) {
      entry = { atA: [], atB: [], itemA: low, itemB: high };
      groups.set(key, entry);
    }
    if (s.position === 'A') entry.atA.push(s);
    else entry.atB.push(s);
  }

  const out: PositionSwapPair[] = [];
  for (const entry of groups.values()) {
    if (entry.atA.length === 0 || entry.atB.length === 0) continue;
    // Average score at each position.
    const meanA = entry.atA.reduce((sum, s) => sum + s.score, 0) / entry.atA.length;
    const meanB = entry.atB.reduce((sum, s) => sum + s.score, 0) / entry.atB.length;
    // Inconsistent when the sign of (score - 0.5) flips between positions —
    // i.e. judge picked one item at position A and the other at position B.
    // For non-binary scores, "preference" is which position scored higher.
    const inconsistent =
      (meanA > PREFERENCE_BOUNDARY) !== (meanB > PREFERENCE_BOUNDARY)
      && Math.abs(meanA - meanB) > POSITION_BIAS_NOISE_FLOOR;
    out.push({
      itemA: entry.itemA,
      itemB: entry.itemB,
      scoreAtA: meanA,
      scoreAtB: meanB,
      inconsistent,
    });
  }
  return out;
}
