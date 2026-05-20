export declare const SPECIALIZED_FALLBACK_REASONS: readonly ["producer_browse_unavailable", "producer_browse_fallback", "region_browse_unavailable", "region_browse_fallback", "compare_retriever_unavailable", "compare_anchor_resolution_failed", "compare_candidates_fallback"];
export type SpecializedFallbackReason = typeof SPECIALIZED_FALLBACK_REASONS[number];
export declare const SPECIALIZED_ROUTE_NAMES: readonly ["producer_browse", "region_browse", "compare_candidates"];
export type SpecializedRouteName = typeof SPECIALIZED_ROUTE_NAMES[number];
export interface SpecializedRouteObservability {
    readonly specializedRouteRequested: SpecializedRouteName | null;
    readonly specializedRouteExecuted: SpecializedRouteName | null;
    readonly fallbackApplied: boolean;
    readonly fallbackReason?: SpecializedFallbackReason | undefined;
}
export declare function toSpecializedRouteMeta(observability?: SpecializedRouteObservability): {
    readonly specializedRouteRequested: SpecializedRouteName | null;
    readonly specializedRouteExecuted: SpecializedRouteName | null;
    readonly fallbackApplied: boolean;
    readonly fallbackReason: SpecializedFallbackReason | null;
};
//# sourceMappingURL=specialized-route.d.ts.map