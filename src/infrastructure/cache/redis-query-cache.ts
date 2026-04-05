/**
 * Redis-backed Query Cache Implementation.
 *
 * Stores complete SearchResponseV1 objects with deterministic TTL.
 * Uses Redis for distributed caching, with automatic JSON serialization.
 *
 * Implements QueryCachePort from domain (dependency inversion).
 */

import type { Redis } from 'ioredis';
import type { QueryCachePort } from '../../domain/performance/port/query-cache.port.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { QueryCacheKey } from '../../domain/performance/model/cache-key.js';

/**
 * Redis query cache: Store complete search responses.
 *
 * Serialization strategy:
 * - Key: Deterministic Redis key from QueryCacheKey (e.g., "query:entity_lookup:abc123:def456")
 * - Value: JSON-serialized SearchResponseV1 (ReadOnly types don't affect JSON)
 * - TTL: Set via Redis EXPIRE command (per RFC-018)
 *
 * Statistics:
 * - Track hits/misses via counter keys (query:stats:hits, query:stats:misses)
 * - Auto-compute hit rate as: hits / (hits + misses)
 * - Size tracked via INFO MEMORY (approximate, includes Redis overhead)
 */
export class RedisQueryCache implements QueryCachePort {
  private readonly redis: Redis;
  private readonly statsKeyHits = 'query:cache:stats:hits';
  private readonly statsKeyMisses = 'query:cache:stats:misses';

  constructor(redis: Redis) {
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
      // Log error for observability (in production, use OpenTelemetry)
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
      // Serialize with replacer to handle readonly types
      const serialized = JSON.stringify(response);

      // Set with EX (expire in seconds)
      await this.redis.set(
        cacheKey.redisKey,
        serialized,
        'EX',
        ttlSeconds,
      );
    } catch (error) {
      // On serialization/write error, log and continue
      // Cache misses are acceptable; don't propagate errors upward
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
      // Use SCAN for non-blocking pattern deletion (vs KEYS which blocks)
      let count = 0;
      let cursor = '0';

      do {
        const [newCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          '100', // Batch size: balance between latency and memory
        );
        cursor = newCursor;

        if (keys.length > 0) {
          await this.redis.del(...keys);
          count += keys.length;
        }
      } while (cursor !== '0');

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
      let cursor = '0';

      do {
        const [newCursor, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          'query:*',
          'COUNT',
          '100',
        );
        cursor = newCursor;
        entriesCount += keys.filter((k) => !k.startsWith('query:cache:stats')).length;
      } while (cursor !== '0');

      // Approximate size from Redis INFO (in production, use more accurate measurement)
      const info = await this.redis.info('memory');
      const usedMemory = this._extractMemoryFromInfo(info);

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
      // Delete all query cache entries (pattern-based deletion is safer than FLUSHDB)
      return await this.deletePattern('query:*');
    } catch (error) {
      console.error('[QueryCache] Clear error:', error);
      return 0;
    }
  }

  /**
   * Extract used_memory bytes from Redis INFO memory output.
   *
   * INFO memory format:
   * ```
   * # Memory
   * used_memory:1234567
   * ...
   * ```
   *
   * @param info - Raw INFO memory output
   * @returns Used memory in bytes (0 on parse error)
   */
  private _extractMemoryFromInfo(info: string): number {
    try {
      const match = info.match(/used_memory:(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }
}
