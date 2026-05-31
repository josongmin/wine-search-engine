/**
 * Upper bound on the number of ranked candidates the resolver emits.
 *
 * The blocker (recall >= 0.99) can return a large candidate pool for noisy /
 * short-form queries, but the decision layer and the clarification UI only ever
 * consume the top of the ranked list:
 *   - resolution reads top-1;
 *   - the calibrated gap reads top-1 vs top-2;
 *   - the conformal prediction set caps at K = 2 for any C >= 1 - 2*alpha;
 *   - the clarification surface (RFC-006 §7) presents a small disambiguation
 *     menu, not the full pool.
 *
 * Bounding the *emitted* list to a named constant keeps the result payload
 * deterministic in size and prevents an unbounded array from flowing into the
 * trace / HTTP response on adversarial high-fan-out queries. The bound is >= 2
 * so the top-1/top-2 calibration contract (buildResolvedCandidates index 0/1)
 * is always satisfiable. Ranking, scoring, ambiguity detection, and calibration
 * all run over the FULL pool first; only the final emitted slice is bounded.
 */
export const MAX_RESOLVED_CANDIDATES = 16;

/**
 * Floor raw score assigned to a candidate whose computed raw score is
 * non-finite (NaN / ±Infinity).
 *
 * A non-finite raw score can only arise from a corrupted MatchSignalSet (e.g. a
 * JSONB column that survived validation but carries NaN, or an upstream divide
 * that produced Infinity). Two contracts force the resolver to neutralize it at
 * the scoring boundary rather than propagate it:
 *   1. The SSoT comparator normalizes NaN to -Infinity, so a poisoned candidate
 *      already sorts to the END of the list — but its raw value is still NaN.
 *   2. `Calibrator.calibrate()` THROWS on a non-finite top1/top2 raw score
 *      (its documented fail-loud contract). Without sanitization a single
 *      poisoned candidate crashes the entire resolution into an exception
 *      instead of degrading to a typed `failed` result.
 *
 * Mapping the value to a finite floor keeps the candidate strictly below any
 * legitimately-scored candidate (the weighted-sum scorer's only negative term
 * is the ambiguity penalty at weight -0.8 over a [0,1] signal, so real scores
 * are >= -0.8) while letting the pipeline degrade gracefully.
 */
const NON_FINITE_RAW_SCORE_FLOOR = -1;

/** Replaces a non-finite raw score with the deterministic floor sentinel. */
export function sanitizeRawScore(rawScore: number): number {
  return Number.isFinite(rawScore) ? rawScore : NON_FINITE_RAW_SCORE_FLOOR;
}

export function classifyLearnedMatcherFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('timed out')
    ? 'learned_matcher_timeout'
    : 'learned_matcher_failed';
}
