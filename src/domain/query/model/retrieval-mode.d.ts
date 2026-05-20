/**
 * Retrieval Mode — extended classification beyond QueryRoute.
 * RFC-017 §8.3 + RFC-005/012 expansion.
 *
 * Each mode represents a distinct retrieval/ranking strategy tied to
 * query intent and desired result structure.
 *
 * Maps to QueryRoute as follows:
 *  - entity_lookup, entity_resolution, no_match_detection → 'entity'
 *  - attribute_search, constraint_filter, producer_browse, region_browse,
 *    compare_candidates, recommendation → 'hybrid'
 *  - similar_items → 'mixed'
 */
export declare const RETRIEVAL_MODES: readonly ["entity_lookup", "attribute_search", "similar_items", "entity_resolution", "constraint_filter", "producer_browse", "region_browse", "compare_candidates", "recommendation", "no_match_detection"];
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
//# sourceMappingURL=retrieval-mode.d.ts.map