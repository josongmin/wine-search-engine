/**
 * All possible next actions the engine can prescribe after classification/resolution.
 */
export const NEXT_ACTIONS = [
  'return_result',
  'clarify',
  'hybrid_search',
  'fail',
  /**
   * TA3-1: Corrective retrieval retry.
   *
   * The resolver detected a recoverable miss condition (low confidence with
   * available alias/noisy evidence, or zero anchors with surface evidence).
   * One corrective retry within the same request is permitted.
   *
   * The pipeline MUST NOT treat this as a broad search fallback. It is an
   * exact-recovery retry: regenerate entity hypotheses, re-hydrate candidates,
   * re-run resolution with recalibrated posteriors.
   *
   * At most 1 per request. If confidence is still below threshold after retry,
   * transition to 'clarify' or 'fail'.
   */
  'corrective_retry',
] as const;

/**
 * The next action the pipeline should take after a decision.
 * - `return_result`    — a result is ready to be returned to the caller.
 * - `clarify`          — the system needs more information from the user.
 * - `hybrid_search`    — fall back to a hybrid retrieval strategy.
 * - `fail`             — the query cannot be handled.
 * - `corrective_retry` — trigger one corrective entity-recovery retry (TA3).
 */
export type NextAction = (typeof NEXT_ACTIONS)[number];
