/**
 * Redis-backed Query Cache Implementation.
 *
 * Stores complete SearchResponseV1 objects with deterministic TTL.
 * Uses {@link RedisCache.getValidatedWithStats} for the read → parse →
 * validate → stats pipeline, eliminating duplicated poisoned-entry handling.
 *
 * Implements QueryCachePort from domain (dependency inversion).
 */

import { z } from 'zod';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { QueryCacheKey } from '../../domain/performance/model/cache-key.js';
import type { QueryCachePort } from '../../domain/performance/port/query-cache.port.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { deleteRedisKeysMatchingPattern } from '../db/redis-delete-by-pattern.js';
import { RedisCache } from '../adapter/redis-cache.js';
import type { GetValidatedStatsOptions } from '../adapter/redis-cache.js';
import type { RedisClient } from '../db/redis-client.js';

/**
 * Lightweight Zod schema for cached SearchResponseV1 structural validation.
 *
 * This validates the same three fields the original manual check enforced:
 * engineDecision (object), results (array), meta (object). Using `.passthrough()`
 * allows all other fields to pass without enumeration — this is a cache
 * integrity check, not an API contract schema.
 *
 * Note: NOT `.strict()` — cached responses may contain extra fields added by
 * newer code versions, and rejecting them would cause unnecessary cache misses
 * during rolling deployments.
 */
/** Max cached results per response — Vespa hard limit is 400, adding headroom for future expansion. */
const MAX_CACHED_RESULTS = 500;
const SearchResponseCacheSchema = z.object({
  engineDecision: z.record(z.unknown()),
  results: z.array(z.unknown()).max(MAX_CACHED_RESULTS),
  meta: z.record(z.unknown()),
}).passthrough();

const STATS_KEY_HITS = 'cache:stats:query:hits';
const STATS_KEY_MISSES = 'cache:stats:query:misses';

const QUERY_STATS: GetValidatedStatsOptions = {
  statsKeyHits: STATS_KEY_HITS,
  statsKeyMisses: STATS_KEY_MISSES,
  logComponent: 'RedisQueryCache',
};

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
const log = bootstrapLogger.child({ component: 'RedisQueryCache' });

export class RedisQueryCache implements QueryCachePort {
  private readonly cache: RedisCache;

  constructor(redis: RedisClient) {
    // defaultTtlSeconds unused (TTL always explicit), but required by RedisCache.
    this.cache = new RedisCache(redis, 0);
  }

  async get(cacheKey: QueryCacheKey): Promise<SearchResponseV1 | undefined> {
    const result = await this.cache.getValidatedWithStats(
      cacheKey.redisKey,
      SearchResponseCacheSchema,
      QUERY_STATS,
    );
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- SearchResponseCacheSchema validates structural shape (engineDecision=object, results=array, meta=object) with passthrough; full type coverage is the serializer's responsibility
    return (result as SearchResponseV1 | null) ?? undefined;
  }

  async set(
    cacheKey: QueryCacheKey,
    response: SearchResponseV1,
    ttlSeconds: number,
  ): Promise<void> {
    try {
      await this.cache.set(cacheKey.redisKey, response, ttlSeconds);
    } catch (error) {
      // On serialization/write error, log and continue
      log.error({ err: error }, 'write error');
    }
  }

  async delete(cacheKey: QueryCacheKey): Promise<void> {
    try {
      await this.cache.del(cacheKey.redisKey);
    } catch (error) {
      log.error({ err: error }, 'delete error');
    }
  }

  async deletePattern(pattern: string): Promise<number> {
    try {
      return await deleteRedisKeysMatchingPattern(this.cache.redis, pattern);
    } catch (error) {
      log.error({ err: error }, 'delete pattern error');
      return 0;
    }
  }

  async getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
    readonly entriesCount: number;
  }> {
    const redis = this.cache.redis;
    try {
      // Get hit/miss counters
      const hitsStr = await redis.get(STATS_KEY_HITS);
      const missesStr = await redis.get(STATS_KEY_MISSES);
      const hits = hitsStr ? parseInt(hitsStr, 10) : 0;
      const misses = missesStr ? parseInt(missesStr, 10) : 0;

      // Count entries with pattern scan. Stats counters live under
      // `cache:stats:query:*`, not `query:*`, so the SCAN naturally excludes
      // them — no extra filter needed.
      let entriesCount = 0;
      for await (const _key of redis.scanIterator({
        MATCH: 'query:*',
        COUNT: 100,
      })) {
        void _key;
        entriesCount++;
      }

      // Approximate size from Redis INFO (production would use more accurate measurement)
      let usedMemory = 0;
      try {
        const infoRaw: unknown = await redis.info('memory');
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
      log.error({ err: error }, 'stats error');
      return { hits: 0, misses: 0, size: 0, entriesCount: 0 };
    }
  }

  async clear(): Promise<number> {
    try {
      return await this.deletePattern('query:*');
    } catch (error) {
      log.error({ err: error }, 'clear error');
      return 0;
    }
  }

  /**
   * Resets hit/miss counters to 0. Stats persist across `clear()` by design
   * (so dashboards can compare hit rate before/after a flush). Call this
   * explicitly only when starting a new measurement window.
   */
  async resetStats(): Promise<void> {
    const redis = this.cache.redis;
    try {
      await Promise.all([
        redis.del(STATS_KEY_HITS),
        redis.del(STATS_KEY_MISSES),
      ]);
    } catch (error) {
      log.error({ err: error }, 'reset stats error');
    }
  }
}
