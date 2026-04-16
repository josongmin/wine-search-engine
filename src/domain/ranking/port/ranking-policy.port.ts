/**
 * T5.5a: Ranking policy port — the seam between relevance ranking and
 * business/diversity policy.
 *
 * Implementations may reorder, demote, or truncate results without touching
 * scoring internals. The Ranker only produces relevance-ordered results;
 * all diversity and business rules live behind this port.
 */

import type { RankedResult } from '../model/ranked-result.js';
import type { ExecutionRetrievalMode } from '../../query/model/engine-execution-contract.js';

/**
 * Context provided to a policy during application.
 * Read-only; the policy must not mutate the context.
 */
export interface PolicyContext {
  /** Query class used for this search (e.g. "semantic_preference"). */
  readonly queryClass: string;
  /**
   * Explicit execution-contract retrieval mode.
   * Recommendation-style ranking rules should prefer this over queryClass
   * when the mode is authoritative.
   */
  readonly effectiveRetrievalMode?: ExecutionRetrievalMode;
  /** The effective retrieval route (e.g. "hybrid"). */
  readonly effectiveRoute: string;
  /** True when the user explicitly constrained wine color/type. */
  readonly hasExplicitWineTypeConstraint?: boolean;
  /** If set, the policy must truncate results to at most this count. */
  readonly maxResults?: number;
}

/**
 * A pluggable ranking-policy hook.
 *
 * Called after all relevance scoring and reranking are complete.
 * The policy receives the ordered {@link RankedResult}s and may return a
 * different (shorter or reordered) slice.  It MUST re-assign `rank` fields
 * so that the returned list is 1-based-contiguous.
 *
 * Implementations must be pure (no side effects, no async I/O).
 */
export interface RankingPolicyPort {
  /**
   * Apply business/diversity policy to a ranked result list.
   *
   * @param results - Current ranking, sorted by relevance descending, 1-based ranks.
   * @param context - Query-level metadata the policy may inspect.
   * @returns Possibly reordered / truncated results with corrected `rank` fields.
   */
  apply(
    results: readonly RankedResult[],
    context: PolicyContext,
  ): readonly RankedResult[];
}
