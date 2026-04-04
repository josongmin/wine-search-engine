/**
 * Policy directives compiled from the query plan, per RFC-005 section 7.3.
 *
 * These directives govern how downstream resolvers behave for the current
 * query plan.
 */
export interface QueryPolicy {
  /** When true, the resolver must find an exact entity match. */
  readonly requireExact: boolean;

  /** When true, approximate (fuzzy / vector) matches are permitted. */
  readonly allowApproximate: boolean;

  /** When true, the system should ask the user for clarification before resolving. */
  readonly requireClarification: boolean;

  /** The fallback strategy when the primary resolution path fails. */
  readonly fallbackMode: 'hybrid' | 'clarify' | 'fail';

  /**
   * Human-readable codes explaining why each policy flag was set.
   * Useful for debugging and audit trails.
   */
  readonly policyReasonCodes: readonly string[];
}
