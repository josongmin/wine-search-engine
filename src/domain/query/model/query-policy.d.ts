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
    /**
     * @deprecated Use `clarificationBias` instead. Hard gate that blocks all
     * resolution regardless of evidence. Retained for backward compatibility
     * during migration — set to false and use clarificationBias.
     */
    readonly requireClarification: boolean;
    /**
     * Soft clarification signal: raises the effective resolveTau by this amount.
     * 0 = no bias (default). 0.15 = ambiguous_short_form caution.
     * Unlike requireClarification (hard gate), this allows resolution when
     * confidence is overwhelming (C >= resolveTau + bias).
     */
    readonly clarificationBias: number;
    /** The fallback strategy when the primary resolution path fails. */
    readonly fallbackMode: 'hybrid' | 'clarify' | 'fail';
    /**
     * Human-readable codes explaining why each policy flag was set.
     * Useful for debugging and audit trails.
     */
    readonly policyReasonCodes: readonly string[];
}
/**
 * Legacy hard clarification gate (`requireClarification`).
 * Call sites should use {@link QueryPolicy.clarificationBias} for new logic;
 * this helper exists so the migration window does not scatter deprecated reads.
 */
export declare function isLegacyRequireClarificationHardGate(policy: QueryPolicy): boolean;
//# sourceMappingURL=query-policy.d.ts.map