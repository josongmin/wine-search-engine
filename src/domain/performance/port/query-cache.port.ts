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
import type { CacheGetResult } from '../../../domain/performance/port/cache-result.js';

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
   *
   * Wave 2 / Fix 1: legacy method retained for callers that don't need to
   * distinguish miss / breaker_open / infra_error / corrupt_entry. Prefer
   * `getWithDiagnostics()` at ops-sensitive call sites.
   */
  get(cacheKey: QueryCacheKey): Promise<SearchResponseV1 | undefined>;

  /**
   * Typed read. Surfaces the full CacheGetResult union so the caller
   * (CacheService) can branch on `kind` and emit distinct silent-skip
   * counters for infra_error vs miss vs corrupt_entry. A fallback
   * implementation that only wraps the legacy `get()` is acceptable —
   * implementations should emit the richer union when they have the
   * information.
   */
  getWithDiagnostics(
    cacheKey: QueryCacheKey,
  ): Promise<CacheGetResult<SearchResponseV1>>;

  /**
   * Store a response in cache with TTL.
   *
   * @param cacheKey - Deterministic cache key
   * @param response - Response to cache
   * @param ttlSeconds - Time-to-live in seconds; defaults to
   *   {@link CACHE_TTL_SECONDS.QUERY} when omitted (E1: TTL SSoT)
   * @returns Promise resolves when cache write completes
   */
  set(
    cacheKey: QueryCacheKey,
    response: SearchResponseV1,
    ttlSeconds?: number,
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
   * @returns Hit/miss/sets counts, size info, eviction stats. `sets` was
   *   added in the E1 telemetry-hook bump (infra.redis-cache-layer maturity
   *   3 → 4) so operators can compute write-amplification and hit-rate
   *   independently.
   */
  getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly sets: number;
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
