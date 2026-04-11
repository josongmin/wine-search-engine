import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';

/**
 * TA3-1: Corrective retrieval retry — trigger condition evaluation.
 *
 * Determines whether a corrective exact-recovery retry should be attempted
 * within the same request. At most ONE retry is permitted per request (TA3-2).
 *
 * Trigger conditions (all must hold, derived from TRACK-A RFC §A3):
 *
 *   C1. Zero anchors extracted — but surface form evidence exists in the query
 *       (non-empty rawQuery after normalization).
 *       Rationale: anchor extraction miss is recoverable; a second pass with
 *       a broader blocker invocation may surface the correct candidate.
 *
 *   C2. Low-confidence resolution (decisionConfidenceC < resolveTau) with
 *       no detected ambiguity.
 *       Rationale: ambiguous misses require clarification, not retry.
 *       A non-ambiguous miss with available evidence is a recall failure —
 *       exactly the class corrective retry is designed to fix.
 *
 *   C3. The resolver's recommended next action is NOT 'clarify' or 'fail'.
 *       Rationale: if the resolver already determined clarification is needed,
 *       retry cannot produce a better outcome.
 *
 * NOT a trigger condition:
 *   - Score just below threshold with ambiguity detected → 'clarify' instead.
 *   - resolveResult.status === 'resolved' → skip (already succeeded).
 *
 * These thresholds are intentionally conservative. The goal is exact recovery,
 * not speculative broadening. See TRACK-A RFC §A3 termination rules.
 */

/**
 * Minimum calibrated confidence C below which a retry is triggered when
 * the query lacks anchors or the resolver returned a non-resolved status.
 *
 * At 0.5 we allow retry when the resolver is effectively uncertain —
 * better than the resolution threshold itself (usually 0.7) to avoid
 * triggering retry for near-miss cases that may still resolve correctly.
 */
const CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Evaluate whether a corrective exact-recovery retry should be attempted.
 *
 * @param plan     The query plan from the first pass.
 * @param result   The entity resolve result from the first pass.
 * @returns `true` if all trigger conditions are met and a retry is warranted.
 */
export function shouldTriggerCorrectiveRetry(
  plan: QueryPlanV1,
  result: EntityResolveResult,
): boolean {
  // Already resolved — no retry needed.
  if (result.status === 'resolved') {
    return false;
  }

  // Resolver recommended clarification or hard fail — respect the decision.
  const nextAction = result.recommendedNextAction;
  if (nextAction === 'clarify' || nextAction === 'fail') {
    return false;
  }

  // Ambiguity detected — retry cannot resolve structural ambiguity.
  if (result.ambiguity !== undefined) {
    return false;
  }

  // Resolver explicitly recommended corrective retry (TA3-1, T6):
  // honour the resolver's own recommendation without re-deriving conditions.
  if (result.recommendedNextAction === 'corrective_retry') {
    return true;
  }

  // C1: Zero anchors (alias lookup missed entirely)
  const zeroAnchors = plan.anchors.length === 0;

  // C2: Low confidence (non-ambiguous miss with C below retry threshold).
  // NaN/non-finite confidence is treated as 0 (worst-case, trigger retry).
  // Rule 28: guard Number.isFinite() before numeric comparison.
  const rawConfidence = result.decisionConfidenceC ?? 0;
  const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0;
  const lowConfidence = confidence < CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD;

  return zeroAnchors || lowConfidence;
}

/**
 * TA3-2: Corrective retry exit conditions after the second pass.
 *
 * Determines the appropriate next action after a corrective retry has run.
 * This is NOT the same as the normal resolver logic — the retry loop has
 * already consumed the one allowed retry, so we must make a definitive choice.
 *
 * Rules (TRACK-A RFC §A3 termination):
 *   - If ambiguity increased after retry → 'clarify'
 *   - If posterior still below threshold → 'clarify' (not 'hybrid_search')
 *   - If protected candidate generated → result is used as-is
 */
export function resolveCorrectiveRetryOutcome(
  retryResult: EntityResolveResult,
): 'accept' | 'clarify' | 'fail' {
  // Retry produced a resolved result — accept it.
  if (retryResult.status === 'resolved') {
    return 'accept';
  }

  // Ambiguity detected after retry → clarify
  if (retryResult.ambiguity !== undefined) {
    return 'clarify';
  }

  // Hard fail recommended by resolver → propagate.
  if (retryResult.recommendedNextAction === 'fail') {
    return 'fail';
  }

  // Confidence still below threshold after retry → clarify (not hybrid fallback).
  // RFC: corrective retry is exact recovery, NOT broad search fallback.
  const confidence = retryResult.decisionConfidenceC ?? 0;
  if (!Number.isFinite(confidence) || confidence < CORRECTIVE_RETRY_CONFIDENCE_THRESHOLD) {
    return 'clarify';
  }

  // Marginal improvement — accept the best available result.
  return 'accept';
}

/**
 * TA5: Calibration base score assigned to a resolved retry result.
 *
 * At rank 1 (best possible), confidence converges to 0.9.
 * At rank = totalCandidates (worst), confidence converges to 0.5.
 * Formula: 0.5 + 0.4 * (1 - (rank - 1) / max(totalCandidates - 1, 1))
 *
 * The 0.5 floor reflects that corrective retry always carries more
 * uncertainty than a first-pass resolved result.
 */
const TA5_CALIBRATION_BASE = 0.5;
/** Upward range above base: rank-1 hit receives base + range = 0.9 confidence. */
const TA5_CALIBRATION_RANGE = 0.4;

/**
 * TA5: Calibrated posterior confidence for a corrective retry outcome.
 *
 * Computes a confidence value from the rank of the top entity in the retry
 * result and the total candidate count:
 *
 *   calibratedConfidence = 0.5 + 0.4 * (1 - normalizedRank)
 *
 * where normalizedRank = (rank - 1) / max(totalCandidates - 1, 1), so:
 *   - rank 1 of N  → normalizedRank 0.0 → confidence 0.9
 *   - rank N of N  → normalizedRank 1.0 → confidence 0.5
 *
 * Returns `undefined` when:
 *   - the retry outcome is not 'accept' (no meaningful posterior to report)
 *   - the retry result has no candidates (cannot derive rank)
 *   - the top entity is absent (resolver produced no confident top-1)
 *
 * @param retryResult  The entity resolve result from the corrective retry pass.
 * @param outcome      The exit decision produced by resolveCorrectiveRetryOutcome.
 * @returns Calibrated confidence in [0.5, 0.9], or undefined if not applicable.
 */
export function computeCorrectiveRetryCalibration(
  retryResult: EntityResolveResult,
  outcome: 'accept' | 'clarify' | 'fail',
): number | undefined {
  // Only calibrate accepted outcomes — clarify/fail have no useful posterior.
  if (outcome !== 'accept') {
    return undefined;
  }

  const totalCandidates = retryResult.candidates.length;
  if (totalCandidates === 0) {
    return undefined;
  }

  // Find the top entity's rank in the candidate list.
  const topEntityId = retryResult.topEntity?.entityId;
  if (topEntityId === undefined) {
    return undefined;
  }

  const topCandidate = retryResult.candidates.find(
    (c) => String(c.entityId) === String(topEntityId),
  );
  if (topCandidate === undefined) {
    return undefined;
  }

  // Rule 26: rank is 1-based; normalizedRank collapses single-candidate results to 0.0.
  const zeroBasedRank = topCandidate.rank - 1;
  // Avoid division by zero when totalCandidates === 1 (single-candidate result → rank 1 → 0).
  const denominator = totalCandidates > 1 ? totalCandidates - 1 : 1;
  const normalizedRank = zeroBasedRank / denominator;
  const calibrated = TA5_CALIBRATION_BASE + TA5_CALIBRATION_RANGE * (1 - normalizedRank);

  // Guard: NaN/Infinity from malformed rank values produce undefined, not a corrupt score.
  // Rule 28: always guard Number.isFinite() before returning a numeric score.
  return Number.isFinite(calibrated) ? calibrated : undefined;
}
