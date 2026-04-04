/**
 * All possible next actions the engine can prescribe after classification/resolution.
 */
export const NEXT_ACTIONS = ['return_result', 'clarify', 'hybrid_search', 'fail'] as const;

/**
 * The next action the pipeline should take after a decision.
 * - `return_result` — a result is ready to be returned to the caller.
 * - `clarify` — the system needs more information from the user.
 * - `hybrid_search` — fall back to a hybrid retrieval strategy.
 * - `fail` — the query cannot be handled.
 */
export type NextAction = (typeof NEXT_ACTIONS)[number];
