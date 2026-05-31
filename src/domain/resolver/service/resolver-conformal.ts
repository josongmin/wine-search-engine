import { CONFORMAL_ALPHA } from '../../shared/config/conformal-config.js';

/** Valid conformal alpha interval is (0, this upper bound]. */
const CONFORMAL_ALPHA_MAX_EXCLUSIVE = 0.5;

/**
 * Default significance level (alpha) for conformal prediction.
 *
 * Imported from SSoT: src/domain/shared/config/conformal-config.ts (W2-BUG-09).
 * At alpha = 0.3 the prediction set has at least 70 % marginal coverage.
 * This means: resolve when C ≥ 0.7, ambiguous when C ≥ 0.4.
 *
 * Previous value (0.1) required C ≥ 0.9 for resolution, causing 96%
 * avoidable abstention because most queries achieved C in [0.70, 0.85].
 * The conformal gate was stricter than T_resolve itself, making the
 * per-class thresholds meaningless.
 *
 * Value should be tuned via AURC on the gate eval set (RFC-009 §5.3).
 */
export const DEFAULT_ALPHA = CONFORMAL_ALPHA;

/**
 * Computes the conformal prediction set size for a single query.
 *
 * The prediction set contracts or expands based on how confidently C exceeds
 * the significance thresholds derived from alpha:
 *
 * - Returns **1** when C >= (1 - alpha)       — top candidate is sufficient.
 * - Returns **2** when C >= (1 - 2 * alpha)   — two candidates are needed.
 * - Returns **K** otherwise                   — abstain; return all candidates.
 *
 * The returned size is ALWAYS clamped to `k`: a prediction set can never name
 * more candidates than actually exist. Without the clamp a high-confidence
 * singleton (k=1) whose C lands in the [1-2*alpha, 1-alpha) band returned 2 —
 * claiming a runner-up that does not exist and breaking the
 * `conformalSetSize <= candidates.length` contract that the result envelope
 * advertises (resolve-result.ts: "K = number of candidates").
 *
 * @param calibratedScore - Calibrated decision confidence C in [0, 1].
 * @param alpha - Significance level (must be in (0, 0.5]).
 * @param k - Total number of candidates (fallback set size on abstain).
 * @returns The conformal prediction set size, in [0, k].
 */
export function computeConformalSetSize(
  calibratedScore: number,
  alpha: number,
  k: number,
): number {
  if (alpha <= 0 || alpha > CONFORMAL_ALPHA_MAX_EXCLUSIVE) {
    throw new RangeError(`computeConformalSetSize: alpha must be in (0, 0.5], got ${alpha}`);
  }
  if (k < 0) {
    throw new RangeError(`computeConformalSetSize: k must be >= 0, got ${k}`);
  }
  if (!Number.isFinite(calibratedScore) || calibratedScore < 0 || calibratedScore > 1) {
    throw new RangeError(
      `computeConformalSetSize: calibratedScore must be finite and in [0, 1], got ${calibratedScore}`,
    );
  }

  // A prediction set can never name more candidates than exist: clamp to k.
  if (calibratedScore >= 1 - alpha) {
    return Math.min(1, k);
  }
  if (calibratedScore >= 1 - 2 * alpha) {
    return Math.min(2, k);
  }
  return k;
}
