/**
 * Deterministic score comparators with NaN handling and tiebreaker.
 *
 * Several modules previously used `>` (not `>=`) for score comparison, which
 * leaves ties resolved by iteration order — and iteration order in Maps and
 * Sets depends on insertion sequence, which depends on input ordering. The
 * result was that the same query against the same data could rank candidates
 * differently across runs.
 *
 * NaN scores compared with `>` always return `false`, so a NaN candidate gets
 * silently kept as the current best until a finite score appears. These
 * helpers normalize NaN to -Infinity (descending sort) and require an explicit
 * tiebreaker key.
 *
 * Reference: bugbash 2026-04-09 section F (eval reproducibility blocker).
 */

/**
 * Compare two scores in descending order with NaN handling.
 * NaN sorts to the end (treated as -Infinity).
 *
 * Returns:
 *   negative when `a > b` (a should come first in descending order)
 *   positive when `b > a`
 *   0 when equal (caller must apply a tiebreaker for stability)
 */
export function compareScoreDescending(a: number, b: number): number {
  const aNormal = Number.isFinite(a) ? a : -Infinity;
  const bNormal = Number.isFinite(b) ? b : -Infinity;
  if (bNormal !== aNormal) return bNormal - aNormal;
  return 0;
}

/**
 * Build a stable comparator function (descending) with a secondary tiebreaker.
 * Use with `Array.prototype.sort` for deterministic descending order.
 *
 * The tiebreaker is compared LEXICOGRAPHICALLY ascending — i.e. the smaller
 * key wins ties. This makes results deterministic across machines because
 * lexicographic ordering on a stable string key (entityId, etc.) is the
 * same everywhere regardless of insertion order.
 */
export function compareScoreWithTiebreaker<T>(
  scoreOf: (item: T) => number,
  tiebreakerOf: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    const scoreCmp = compareScoreDescending(scoreOf(a), scoreOf(b));
    if (scoreCmp !== 0) return scoreCmp;
    const ak = tiebreakerOf(a);
    const bk = tiebreakerOf(b);
    if (ak < bk) return -1;
    if (ak > bk) return 1;
    return 0;
  };
}

/**
 * Pick the maximum element from a list by score, with a deterministic
 * tiebreaker on equal scores. Returns `undefined` for empty input.
 *
 * NaN scores are treated as -Infinity (never picked over a finite score).
 * When all scores are non-finite, the lexicographically smallest tiebreaker
 * key wins.
 *
 * This is the canonical replacement for `for (...) if (score > best.score)`
 * patterns where the loop's iteration order leaks into the result.
 */
export function pickMaxByScore<T>(
  items: readonly T[],
  scoreOf: (item: T) => number,
  tiebreakerOf: (item: T) => string,
): T | undefined {
  if (items.length === 0) return undefined;
  let best = items[0]!;
  let bestScore = Number.isFinite(scoreOf(best)) ? scoreOf(best) : -Infinity;
  let bestKey = tiebreakerOf(best);
  for (let i = 1; i < items.length; i++) {
    const cur = items[i]!;
    const rawScore = scoreOf(cur);
    const curScore = Number.isFinite(rawScore) ? rawScore : -Infinity;
    if (curScore > bestScore) {
      best = cur;
      bestScore = curScore;
      bestKey = tiebreakerOf(cur);
      continue;
    }
    if (curScore === bestScore) {
      const curKey = tiebreakerOf(cur);
      if (curKey < bestKey) {
        best = cur;
        bestKey = curKey;
      }
    }
  }
  return best;
}
