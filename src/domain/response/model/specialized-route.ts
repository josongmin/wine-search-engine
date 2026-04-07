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

export const SPECIALIZED_ROUTE_NAMES = [
  'producer_browse',
  'region_browse',
  'compare_candidates',
] as const;

export type SpecializedRouteName = typeof SPECIALIZED_ROUTE_NAMES[number];

export interface SpecializedRouteObservability {
  readonly specializedRouteRequested: SpecializedRouteName | null;
  readonly specializedRouteExecuted: SpecializedRouteName | null;
  readonly fallbackApplied: boolean;
  readonly fallbackReason?: SpecializedFallbackReason | undefined;
}

export function toSpecializedRouteMeta(
  observability?: SpecializedRouteObservability,
): {
  readonly specializedRouteRequested: SpecializedRouteName | null;
  readonly specializedRouteExecuted: SpecializedRouteName | null;
  readonly fallbackApplied: boolean;
  readonly fallbackReason: SpecializedFallbackReason | null;
} {
  return {
    specializedRouteRequested: observability?.specializedRouteRequested ?? null,
    specializedRouteExecuted: observability?.specializedRouteExecuted ?? null,
    fallbackApplied: observability?.fallbackApplied ?? false,
    fallbackReason: observability?.fallbackApplied === true
      ? (observability.fallbackReason ?? null)
      : null,
  };
}
