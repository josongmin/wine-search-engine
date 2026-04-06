import type { SpecializedFallbackReason } from './specialized-fallback-reason.js';

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
  observability?: SpecializedRouteObservability | undefined,
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
