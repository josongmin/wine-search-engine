/**
 * QueryCachePort — Domain port for query-level response caching.
 *
 * Implementations cache complete search responses for deterministic queries,
 * enabling instant response on cache hits without recomputation.
 *
 * Hexagonal: This is an infrastructure concern (query caching may use Redis, in-memory, etc.)
 * expressed as a domain interface for dependency inversion.
 */

import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { QueryCacheKey } from '../model/cache-key.js';

/**
 * Query cache port: Store and retrieve complete search responses.
 *
 * Implementations must:
 * 1. Be deterministic (same key → same response)
 * 2. Respect TTL bounds (entries auto-expire after configured duration)
 * 3. Support async operations (Redis, external cache)
 * 4. Provide hit/miss tracking for observability
 */
export interface QueryCachePort {
  /**
   * Retrieve a cached response by key.
   *
   * @param cacheKey - Deterministic cache key
   * @returns Cached response if hit, undefined if miss or expired
   * @throws Only on infrastructure errors (not on miss)
   */
  get(cacheKey: QueryCacheKey): Promise<SearchResponseV1 | undefined>;

  /**
   * Store a response in cache with TTL.
   *
   * @param cacheKey - Deterministic cache key
   * @param response - Response to cache
   * @param ttlSeconds - Time-to-live in seconds (after which entry expires)
   * @returns Promise resolves when cache write completes
   */
  set(
    cacheKey: QueryCacheKey,
    response: SearchResponseV1,
    ttlSeconds: number,
  ): Promise<void>;

  /**
   * Remove a specific cache entry.
   *
   * @param cacheKey - Cache key to invalidate
   * @returns Promise resolves when deletion completes
   */
  delete(cacheKey: QueryCacheKey): Promise<void>;

  /**
   * Invalidate all entries matching a pattern.
   *
   * Pattern format: Redis glob (e.g., "query:entity_lookup:*").
   * Used for batch invalidation on model/profile changes.
   *
   * @param pattern - Glob pattern for Redis SCAN
   * @returns Count of entries invalidated
   */
  deletePattern(pattern: string): Promise<number>;

  /**
   * Get current cache statistics.
   *
   * @returns Hit/miss counts, size info, eviction stats
   */
  getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly size: number; // bytes
    readonly entriesCount: number;
  }>;

  /**
   * Clear entire cache.
   *
   * Use sparingly (emergency invalidation only).
   *
   * @returns Count of entries cleared
   */
  clear(): Promise<number>;
}
