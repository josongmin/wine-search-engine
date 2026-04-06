export const SPECIALIZED_FALLBACK_REASONS = [
  'producer_browse_unavailable',
  'producer_browse_fallback',
  'region_browse_unavailable',
  'region_browse_fallback',
  'compare_retriever_unavailable',
  'compare_anchor_resolution_failed',
  'compare_candidates_fallback',
] as const;

export type SpecializedFallbackReason = typeof SPECIALIZED_FALLBACK_REASONS[number];

