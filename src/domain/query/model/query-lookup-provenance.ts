import type { NormalizedQueryViews } from './query-views.js';

/**
 * Shared query-side provenance for resolver and decision traces (RFC-006/007).
 *
 * Resolver traces may extend this with {@link ResolverQueryProvenance} in the
 * resolver domain; decision traces use {@link DecisionQueryProvenance} as an
 * alias for the same shape carried forward from resolution.
 */
export interface QueryLookupProvenance {
  /** Multi-view normalization snapshot used during lookup. */
  readonly normalizedQueryViews?: NormalizedQueryViews | undefined;

  /** Lookup variants that contributed to anchor extraction. */
  readonly anchorLookupVariants?: readonly string[] | undefined;

  /** Lookup strategies that contributed to anchor extraction. */
  readonly anchorLookupStrategies?: readonly string[] | undefined;
}
