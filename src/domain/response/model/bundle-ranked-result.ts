/**
 * ADR-013 Phase 1c: BundleRankedResult.
 *
 * Composes `RankedResult[]` across subquery slots with bundle-scoped
 * metadata. Separate type from `RankedResult` — consumers that do not
 * handle bundles never need to discriminate. See ADR-013 §3 for the
 * ranked-result carrier-contract decision (Option A: separate type).
 */

import { z } from 'zod';
import type { RankedResult } from '../../ranking/model/ranked-result.js';

/** Upper bound on subquery / bundle ID string lengths. Mirrors
 *  `NODE_ID_MAX_LEN` in constraint-graph.ts without introducing a
 *  cross-module import. */
const BUNDLE_ID_MAX_LEN = 128;

/** Upper bound on shared-budget usage descriptor count. The graph
 *  `edges` array is already bounded at 1024 (see constraint-graph.ts),
 *  but in practice a single bundle sees O(1) shared-budget resources. */
const BUNDLE_SHARED_BUDGET_MAX = 16;

export interface BundleSharedBudgetUsage {
  readonly resource: 'price_total' | 'time' | 'count';
  readonly currency?: 'KRW' | 'USD' | undefined;
  readonly used: number;
  readonly max: number;
}

export interface BundleRankedResult {
  /** Subquery-node `nodeId` this ranked result satisfies. */
  readonly subqueryId: string;
  /** Opaque bundle grouping key — all results in the same bundle share
   *  this value. Construction is deterministic (sorted concat of
   *  subquery IDs) so two identical inputs produce the same bundleId. */
  readonly bundleId: string;
  /** The wrapped single-candidate ranking payload. `ranked.rank` is the
   *  intra-subquery position (always 1 in the assignment output, since
   *  the selector returns exactly one candidate per subquery). */
  readonly ranked: RankedResult;
  /** Per-resource shared-budget telemetry from the solver. Absent when
   *  the graph carries no `shares_budget` edges. */
  readonly sharedBudgetUsage?: readonly BundleSharedBudgetUsage[] | undefined;
}

const BundleSharedBudgetUsageSchema = z
  .object({
    resource: z.enum(['price_total', 'time', 'count']),
    currency: z.enum(['KRW', 'USD']).optional(),
    used: z.number().finite().nonnegative(),
    max: z.number().finite().nonnegative(),
  })
  .strict();

/**
 * Zod schema for the *wrapper* shape — the inner `ranked: RankedResult`
 * is carried as an opaque passthrough because `RankedResult`'s full Zod
 * contract lives elsewhere and re-validating it here would couple the
 * bundle carrier to every evolution of that type.
 */
export const BundleRankedResultShapeSchema = z
  .object({
    subqueryId: z.string().min(1).max(BUNDLE_ID_MAX_LEN),
    bundleId: z.string().min(1).max(BUNDLE_ID_MAX_LEN),
    ranked: z.unknown(),
    sharedBudgetUsage: z
      .array(BundleSharedBudgetUsageSchema)
      .max(BUNDLE_SHARED_BUDGET_MAX)
      .optional(),
  })
  .strict();

/**
 * Deterministic bundle-ID helper — the same sorted tuple of subquery
 * IDs always hashes to the same string. Tests lock this for replay.
 */
export function computeBundleId(subqueryIds: readonly string[]): string {
  const sorted = [...subqueryIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `bundle:${sorted.join('|')}`;
}
