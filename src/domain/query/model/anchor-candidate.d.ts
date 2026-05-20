import type { CanonicalEntityId } from '../../shared/types/index.js';
/**
 * A candidate anchor entity extracted from the query surface form.
 *
 * The `confidence` field represents the planner's estimate that this surface
 * form refers to the candidate entities. This is an anchor confidence score,
 * NOT a calibrated decision confidence C.
 */
export interface AnchorCandidate {
    /** The original text span as it appeared in the query. */
    readonly surfaceForm: string;
    /** Lowercased, accent-stripped, whitespace-collapsed form used for matching. */
    readonly normalizedForm: string;
    /** Entity IDs that this surface form may refer to. */
    readonly candidateEntityIds: readonly CanonicalEntityId[];
    /**
     * Query lookup variants that produced this anchor candidate.
     *
     * This is provenance for noisy lookup debugging only. It records which
     * normalized query views matched this anchor during extraction.
     */
    readonly lookupVariants?: readonly string[] | undefined;
    /**
     * Lookup strategies that produced this anchor candidate.
     *
     * Examples: exact, compact_exact, fuzzy_char_ngram, transliterated.
     * This is provenance only and should not drive deterministic planner logic.
     */
    readonly lookupStrategies?: readonly string[] | undefined;
    /**
     * Anchor confidence in [0, 1].
     * This is NOT a calibrated decision confidence C.
     */
    readonly confidence: number;
    /**
     * How this anchor candidate was discovered.
     *
     * - `alias`            — AnchorExtractor matched a known alias/canonical form
     * - `planner_heuristic`— Planner emitted via heuristic (e.g. fuzzy expansion)
     * - `entity_lookup`    — Explicit entity-id lookup from query context
     * - `blocker_seed`     — TA2-4: high-recall blocker returned this ID but it
     *                        was absent from alias anchors; signal set is zero-filled
     *                        and populated downstream by the scorer's attribute path
     */
    readonly source: 'alias' | 'planner_heuristic' | 'entity_lookup' | 'blocker_seed';
}
//# sourceMappingURL=anchor-candidate.d.ts.map