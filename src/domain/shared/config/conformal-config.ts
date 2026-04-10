/**
 * Conformal prediction configuration — SSoT for alpha and coverage constants.
 *
 * W2-BUG-09: Alpha was hardcoded as 0.3 in resolver.ts and eval scripts.
 * Any consumer needing the conformal significance level MUST import from here.
 *
 * Coverage target: 70%.  Alpha = 1 - coverage.
 * At alpha = 0.3 the prediction set has at least 70% marginal coverage.
 * This means: resolve when C >= 0.7, ambiguous when C >= 0.4.
 *
 * Value should be tuned via AURC on the gate eval set (RFC-009 §5.3).
 */

/** Significance level (alpha) for conformal prediction. α = 1 - coverage. */
export const CONFORMAL_ALPHA = 0.3;

/** Minimum coverage target for conformal prediction sets (1 - α). */
export const CONFORMAL_COVERAGE_TARGET = 1 - CONFORMAL_ALPHA;
