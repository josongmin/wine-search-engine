/**
 * Redis-backed Embedding Cache Implementation.
 *
 * Stores dense embedding vectors as JSON for simplicity and compatibility.
 * Uses node-redis for distributed caching.
 *
 * Implements EmbeddingCachePort from domain (dependency inversion).
 *
 * Trade-off: JSON is ~2x larger than binary, but:
 * - Simpler implementation (no binary serialization)
 * - Compatible with node-redis JSON storage
 * - Still memory-efficient for typical embedding sizes (384-1024 dims)
 */

import type { RedisClient } from '../db/redis-client.js';
import type { EmbeddingCachePort } from '../../domain/performance/port/embedding-cache.port.js';
import type { EmbeddingCacheKey } from '../../domain/performance/model/cache-key.js';

/**
 * Redis embedding cache: Store dense vectors efficiently.
 *
 * Storage strategy:
 * - Key: Deterministic Redis key from EmbeddingCacheKey (e.g., "embedding:bge-m3:abc123")
 * - Value: JSON-serialized Float32 array
 * - TTL: 7200s (embeddings very stable, only change on model upgrade)
 */
export class RedisEmbeddingCache implements EmbeddingCachePort {
  private readonly redis: RedisClient;
  private readonly statsKeyHits = 'embedding:cache:stats:hits';
  private readonly statsKeyMisses = 'embedding:cache:stats:misses';

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async get(cacheKey: EmbeddingCacheKey): Promise<readonly number[] | undefined> {
    try {
      const cached = await this.redis.get(cacheKey.redisKey);

      if (cached === null) {
        await this.redis.incr(this.statsKeyMisses);
        return undefined;
      }

      await this.redis.incr(this.statsKeyHits);
      const embedding = JSON.parse(cached) as readonly number[];
      return embedding;
    } catch (error) {
      console.error('[EmbeddingCache] Deserialization error:', error);
      await this.redis.incr(this.statsKeyMisses);
      return undefined;
    }
  }

  async set(
    cacheKey: EmbeddingCacheKey,
    embedding: readonly number[],
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const serialized = JSON.stringify(embedding);
      await this.redis.set(cacheKey.redisKey, serialized, { EX: ttlSeconds });
    } catch (error) {
      console.error('[EmbeddingCache] Write error:', error);
    }
  }

  async delete(cacheKey: EmbeddingCacheKey): Promise<void> {
    try {
      await this.redis.del(cacheKey.redisKey);
    } catch (error) {
      console.error('[EmbeddingCache] Delete error:', error);
    }
  }

  async deleteByModel(modelId: string): Promise<number> {
    try {
      return await this._deleteByPattern(`embedding:${modelId}:*`);
    } catch (error) {
      console.error('[EmbeddingCache] Delete by model error:', error);
      return 0;
    }
  }

  async getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
    readonly entriesCount: number;
  }> {
    try {
      // Get hit/miss counters
      const hitsStr = await this.redis.get(this.statsKeyHits);
      const missesStr = await this.redis.get(this.statsKeyMisses);
      const hits = hitsStr ? parseInt(hitsStr, 10) : 0;
      const misses = missesStr ? parseInt(missesStr, 10) : 0;

      // Count entries and compute size
      let entriesCount = 0;
      let cursorSize = 0;
      for await (const key of this.redis.scanIterator({
        MATCH: 'embedding:*',
        COUNT: 100,
      })) {
        const keyStr = String(key);
        if (!keyStr.startsWith('embedding:cache:stats')) {
          entriesCount++;
          try {
            const size = await this.redis.strlen(keyStr);
            if (typeof size === 'number') {
              cursorSize += size;
            }
          } catch {
            // Skip on error
          }
        }
      }

      return {
        hits,
        misses,
        size: cursorSize,
        entriesCount,
      };
    } catch (error) {
      console.error('[EmbeddingCache] Stats error:', error);
      return { hits: 0, misses: 0, size: 0, entriesCount: 0 };
    }
  }

  async clear(): Promise<number> {
    try {
      return await this._deleteByPattern('embedding:*');
    } catch (error) {
      console.error('[EmbeddingCache] Clear error:', error);
      return 0;
    }
  }

  /**
   * Delete all keys matching a pattern using scanIterator.
   */
  private async _deleteByPattern(pattern: string): Promise<number> {
    let count = 0;
    for await (const key of this.redis.scanIterator({
      MATCH: pattern,
      COUNT: 100,
    })) {
      if (typeof key === 'string') {
        await this.redis.del(key);
        count++;
      }
    }
    return count;
  }
}
