import type { EntityId } from '../../shared/types/index.js';

/**
 * Port for the blocking stage of entity resolution, per RFC-006 §3.3.
 *
 * Blocking narrows the candidate set from the full entity catalog to a
 * manageable number of plausible matches. The recall target is >= 0.99:
 * the correct entity must almost always survive blocking.
 *
 * Infrastructure adapters implement this using inverted indices, prefix
 * tries, n-gram indices, or other high-recall retrieval strategies.
 */
export interface BlockingPort {
  /**
   * Returns candidate entity IDs that pass the blocking filter.
   *
   * @param query - The original user query string.
   * @param normalizedQuery - Lowercased, accent-stripped, whitespace-collapsed form.
   * @param limit - Maximum number of candidates to return (default: implementation-defined).
   * @returns Entity IDs that are plausible matches, ordered by blocking score descending.
   */
  block(query: string, normalizedQuery: string, limit?: number): Promise<readonly EntityId[]>;
}
