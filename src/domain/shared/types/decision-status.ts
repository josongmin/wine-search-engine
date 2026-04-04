/**
 * All possible statuses for a resolution decision.
 */
export const DECISION_STATUSES = ['resolved', 'ambiguous', 'failed'] as const;

/**
 * The outcome status of a query resolution decision.
 * - `resolved` — a definitive result was found.
 * - `ambiguous` — multiple plausible results exist; clarification may be needed.
 * - `failed` — the system could not produce a valid result.
 */
export type DecisionStatus = (typeof DECISION_STATUSES)[number];
