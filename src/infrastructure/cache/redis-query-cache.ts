/**
 * Redis-backed Query Cache Implementation.
 *
 * Stores complete SearchResponseV1 objects with deterministic TTL.
 * Uses node-redis for distributed caching, with automatic JSON serialization.
 *
 * Implements QueryCachePort from domain (dependency inversion).
 */

import type { RedisClient } from '../db/redis-client.js';
import type { QueryCachePort } from '../../domain/performance/port/query-cache.port.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { QueryCacheKey } from '../../domain/performance/model/cache-key.js';

/**
 * Redis query cache: Store complete search responses.
 *
 * Serialization strategy:
 * - Key: Deterministic Redis key from QueryCacheKey (e.g., "query:entity_lookup:abc123:def456")
 * - Value: JSON-serialized SearchResponseV1 (ReadOnly types don't affect JSON)
 * - TTL: Set via Redis EX option (per RFC-018)
 *
 * Statistics:
 * - Track hits/misses via counter keys (query:stats:hits, query:stats:misses)
 * - Auto-compute hit rate as: hits / (hits + misses)
 */
export class RedisQueryCache implements QueryCachePort {
  private readonly redis: RedisClient;
  private readonly statsKeyHits = 'query:cache:stats:hits';
  private readonly statsKeyMisses = 'query:cache:stats:misses';

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async get(cacheKey: QueryCacheKey): Promise<SearchResponseV1 | undefined> {
    try {
      const cached = await this.redis.get(cacheKey.redisKey);

      if (cached === null) {
        // Cache miss
        await this.redis.incr(this.statsKeyMisses);
        return undefined;
      }

      // Cache hit: Parse and return
      await this.redis.incr(this.statsKeyHits);
      const response = JSON.parse(cached) as SearchResponseV1;
      return response;
    } catch (error) {
      // On deserialization error, treat as miss (don't throw)
      console.error('[QueryCache] Deserialization error:', error);
      await this.redis.incr(this.statsKeyMisses);
      return undefined;
    }
  }

  async set(
    cacheKey: QueryCacheKey,
    response: SearchResponseV1,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      const serialized = JSON.stringify(response);
      await this.redis.set(cacheKey.redisKey, serialized, { EX: ttlSeconds });
    } catch (error) {
      // On serialization/write error, log and continue
      console.error('[QueryCache] Write error:', error);
    }
  }

  async delete(cacheKey: QueryCacheKey): Promise<void> {
    try {
      await this.redis.del(cacheKey.redisKey);
    } catch (error) {
      console.error('[QueryCache] Delete error:', error);
    }
  }

  async deletePattern(pattern: string): Promise<number> {
    try {
      let count = 0;
      for await (const key of this.redis.scanIterator({
        MATCH: pattern,
        COUNT: 100,
      })) {
        await this.redis.del(key);
        count++;
      }
      return count;
    } catch (error) {
      console.error('[QueryCache] Delete pattern error:', error);
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

      // Count entries with pattern scan (query:* keys, excluding stats)
      let entriesCount = 0;
      for await (const key of this.redis.scanIterator({
        MATCH: 'query:*',
        COUNT: 100,
      })) {
        const keyStr = String(key);
        if (!keyStr.startsWith('query:cache:stats')) {
          entriesCount++;
        }
      }

      // Approximate size from Redis INFO (production would use more accurate measurement)
      let usedMemory = 0;
      try {
        const infoRaw: unknown = await this.redis.info('memory');
        const infoStr =
          typeof infoRaw === 'string'
            ? infoRaw
            : Array.isArray(infoRaw)
              ? infoRaw.join('\n')
              : String(infoRaw);
        const match = infoStr.match(/used_memory:(\d+)/);
        const mem = match?.[1];
        if (mem !== undefined) {
          usedMemory = parseInt(mem, 10);
        }
      } catch {
        // INFO unavailable, use 0
      }

      return {
        hits,
        misses,
        size: usedMemory,
        entriesCount,
      };
    } catch (error) {
      console.error('[QueryCache] Stats error:', error);
      return { hits: 0, misses: 0, size: 0, entriesCount: 0 };
    }
  }

  async clear(): Promise<number> {
    try {
      return await this.deletePattern('query:*');
    } catch (error) {
      console.error('[QueryCache] Clear error:', error);
      return 0;
    }
  }
}
