/**
 * All possible next actions the engine can prescribe after classification/resolution.
 */
export const NEXT_ACTIONS = [
  'return_result',
  'clarify',
  'hybrid_search',
  'fail',
  /**
   * Wave 1 (Cluster F) — corpus-gap relax-and-retry.
   *
   * The candidate pool was empty AND the planner emitted a high-confidence
   * anchor (the user asked something specific). The pipeline should drop
   * the identity-bearing constraints and re-run as a similar-items / browse
   * retrieval so the response carries adjacent suggestions instead of an
   * unhelpful clarification request.
   */
  'relax_and_retry',
  /**
   * Wave 1 (Cluster F) — corpus-gap honest admission.
   *
   * Final, terminal action when the candidate pool is empty AND the planner
   * had a high-confidence anchor AND relax-and-retry is not viable / has
   * already been tried. The pipeline emits a deterministic
   * "not in our catalogue" template (see synthesis-fallback-templates.ts
   * `corpusGapAdmission`). Distinct from `clarify` because no amount of
   * user clarification will make the entity exist in the corpus.
   */
  'admit_to_user',
] as const;

/**
 * The next action the pipeline should take after a decision.
 * - `return_result`    — a result is ready to be returned to the caller.
 * - `clarify`          — the system needs more information from the user.
 * - `hybrid_search`    — fall back to a hybrid retrieval strategy.
 * - `fail`             — the query cannot be handled.
 * - `relax_and_retry`  — drop identity constraints + re-run as similar-items
 *                        (Wave 1 corpus-gap recovery).
 * - `admit_to_user`    — emit deterministic "not in catalogue" template
 *                        (Wave 1 corpus-gap final admission).
 */
export type NextAction = (typeof NEXT_ACTIONS)[number];
