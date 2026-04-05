/**
 * EmbeddingCachePort — Domain port for embedding memoization.
 *
 * Implementations cache dense embeddings for query text, enabling
 * reuse across multiple retrieval passes (very high value, stable cache).
 *
 * Embeddings are extremely stable (only change on model upgrade),
 * so TTL can be very long (hours to days).
 */

import type { EmbeddingCacheKey } from '../model/cache-key.js';

/**
 * Embedding cache port: Store and retrieve dense embeddings.
 *
 * Implementations must:
 * 1. Store dense vectors as typed arrays or byte buffers
 * 2. Support fast lookup by text + model ID
 * 3. Be resilient to missing embeddings (fall back to computing them)
 * 4. Track cache statistics for observability
 */
export interface EmbeddingCachePort {
  /**
   * Retrieve a cached embedding by key.
   *
   * @param cacheKey - Deterministic embedding cache key
   * @returns Cached embedding vector if hit, undefined if miss
   * @throws Only on infrastructure errors (not on miss)
   */
  get(cacheKey: EmbeddingCacheKey): Promise<readonly number[] | undefined>;

  /**
   * Store an embedding in cache with TTL.
   *
   * @param cacheKey - Deterministic embedding cache key
   * @param embedding - Dense embedding vector
   * @param ttlSeconds - Time-to-live in seconds
   * @returns Promise resolves when cache write completes
   */
  set(
    cacheKey: EmbeddingCacheKey,
    embedding: readonly number[],
    ttlSeconds: number,
  ): Promise<void>;

  /**
   * Remove a specific embedding from cache.
   *
   * @param cacheKey - Cache key to invalidate
   * @returns Promise resolves when deletion completes
   */
  delete(cacheKey: EmbeddingCacheKey): Promise<void>;

  /**
   * Invalidate all embeddings for a specific model.
   *
   * Used when model is upgraded (all embeddings become stale).
   *
   * @param modelId - Model identifier
   * @returns Count of entries invalidated
   */
  deleteByModel(modelId: string): Promise<number>;

  /**
   * Get current cache statistics.
   *
   * @returns Hit/miss counts, size info
   */
  getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly size: number; // bytes
    readonly entriesCount: number;
  }>;

  /**
   * Clear entire embedding cache.
   *
   * Use sparingly (emergency invalidation only).
   *
   * @returns Count of entries cleared
   */
  clear(): Promise<number>;
}
