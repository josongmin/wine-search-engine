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

export const RETRIEVAL_MODES = [
  // === Existing route equivalents ===
  'entity_lookup',         // Single entity resolve (route='entity')
  'attribute_search',      // Semantic/constraint search (route='hybrid')
  'similar_items',         // Anchor-based similarity (route='mixed')

  // === Semantic modes ===
  'entity_resolution',     // Ambiguous entity → disambiguation surface (route='entity')
  'constraint_filter',     // Hard constraint filtering only (route='hybrid')

  // === Browsing modes ===
  'producer_browse',       // Producer entity → wine set (route='hybrid')
  'region_browse',         // Region/appellation → wine set (route='hybrid')

  // === Comparison & discovery ===
  'compare_candidates',    // Multi-entity comparison (route='hybrid')
  'recommendation',        // Occasion/pairing-based discovery (route='hybrid')

  // === Failure modes ===
  'no_match_detection',    // OOV or non-existent entity (route='entity')
] as const;

export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
