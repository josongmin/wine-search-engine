import type { ConstraintOperator } from '../../shared/types/index.js';
/**
 * A mapping from a natural-language phrase to a structured attribute constraint.
 *
 * These mappings are deterministic: the same phrase + version always produces
 * the same constraint. LLM-generated hard constraints are forbidden per RFC-004.
 */
export interface NLMapping {
    /** The natural-language phrase (e.g. "묵직한", "드라이"). */
    readonly phrase: string;
    /** The attribute being constrained (e.g. "body", "sweetness", "occasion"). */
    readonly mappedAttribute: string;
    /** The constraint operator. */
    readonly operator: ConstraintOperator;
    /**
     * The constraint value.
     * - For '=' / '<=' / '>=': a single number or string.
     * - For 'range': a tuple [min, max].
     * - For 'in': a string value (single-element match in array attributes).
     */
    readonly value: number | readonly [number, number] | string;
    /**
     * Confidence that this mapping is correct.
     * Range [0, 1]. This is a mapping confidence, NOT a calibrated decision C.
     */
    readonly mappingConfidence: number;
    /** Version identifier for the mapping table (e.g. "v1.0", "v1.1"). */
    readonly mappingVersion: string;
    /** Provenance of this mapping (e.g. "manual_curation", "user_feedback"). */
    readonly source: string;
}
//# sourceMappingURL=nl-mapping.d.ts.map