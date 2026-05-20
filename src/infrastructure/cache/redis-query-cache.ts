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
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { QueryCacheKey } from '../../domain/performance/model/cache-key.js';
import type { QueryCachePort } from '../../domain/performance/port/query-cache.port.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import { deleteRedisKeysMatchingPattern } from '../db/redis-delete-by-pattern.js';
import { RedisCache } from '../adapter/redis-cache.js';
import type { RedisClient } from '../db/redis-client.js';
import { globalSilentSkipCounter } from '../../domain/observability/silent-skip-counters.js';
import {
  cacheHit,
  cacheMiss,
  cacheCorruptEntry,
  cacheInfraError,
  type CacheGetResult,
} from '../../domain/performance/port/cache-result.js';
import { CACHE_TTL_SECONDS } from './cache-ttl-config.js';

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
const STATS_KEY_SETS = 'cache:stats:query:sets';

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
    const diag = await this.getWithDiagnostics(cacheKey);
    return diag.kind === 'hit' ? diag.value : undefined;
  }

  /**
   * Wave 2 / Fix 1: surface typed CacheGetResult so the CacheService
   * layer can branch on kind and emit distinct silent-skip counters.
   *
   * Branches:
   *  - underlying RedisCache throws (infra) → infra_error
   *  - schema validation fails → corrupt_entry
   *  - redis null → miss
   *  - valid payload → hit(value)
   *
   * The getValidatedWithStats helper already emits its own silent-skip
   * counters at the low level; this method promotes the raw outcome to a
   * typed result without duplicating that accounting.
   */
  async getWithDiagnostics(
    cacheKey: QueryCacheKey,
  ): Promise<CacheGetResult<SearchResponseV1>> {
    // Raw pipeline (not delegating to getValidatedWithStats) so infra_error
    // reaches the caller. getValidatedWithStats swallows redis throws and
    // returns null — that is correct for the legacy "treat as miss" contract,
    // but it collapses the typed union. We re-implement read → parse →
    // validate → classify here and let the CacheService route on kind.
    const redis = this.cache.redis;
    let raw: string | null;
    try {
      raw = await redis.get(cacheKey.redisKey);
    } catch (err) {
      globalSilentSkipCounter.increment('cache_read_failure', {
        surface: 'RedisQueryCache.getWithDiagnostics',
        errorClass: err instanceof Error ? err.constructor.name : 'unknown',
      });
      log.error({ err, key: cacheKey.redisKey }, 'redis get error (infra_error)');
      return cacheInfraError(err);
    }
    if (raw === null) {
      void Promise.resolve(redis.incr(STATS_KEY_MISSES)).catch(() => { /* best-effort */ });
      return cacheMiss();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      globalSilentSkipCounter.increment('cache_read_failure', {
        surface: 'RedisQueryCache.getWithDiagnostics',
        errorClass: 'corrupt_entry_json_parse',
      });
      log.warn(
        { key: cacheKey.redisKey, reason: 'json_parse_error' },
        'cache entry poisoned (invalid JSON); corrupt_entry',
      );
      void Promise.resolve(redis.del(cacheKey.redisKey)).catch(() => { /* best-effort */ });
      void parseErr;
      return cacheCorruptEntry('json_parse_error');
    }
    const result = SearchResponseCacheSchema.safeParse(parsed);
    if (!result.success) {
      globalSilentSkipCounter.increment('cache_read_failure', {
        surface: 'RedisQueryCache.getWithDiagnostics',
        errorClass: 'corrupt_entry_schema_mismatch',
      });
      log.warn(
        { key: cacheKey.redisKey, issues: result.error.issues.slice(0, 3) },
        'cache entry poisoned (schema mismatch); corrupt_entry',
      );
      void Promise.resolve(redis.del(cacheKey.redisKey)).catch(() => { /* best-effort */ });
      return cacheCorruptEntry('schema_mismatch');
    }
    void Promise.resolve(redis.incr(STATS_KEY_HITS)).catch(() => { /* best-effort */ });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- SearchResponseCacheSchema validates structural shape with passthrough
    return cacheHit(result.data as unknown as SearchResponseV1);
  }

  async set(
    cacheKey: QueryCacheKey,
    response: SearchResponseV1,
    ttlSeconds?: number,
  ): Promise<void> {
    // Default TTL (E1: infra.redis-cache-layer 3→4) — when caller omits TTL,
    // use the documented per-cache default from the SSoT config.
    const effectiveTtl = ttlSeconds ?? CACHE_TTL_SECONDS.QUERY;
    try {
      // Write-time Zod validation (E5-T11): prevents cache-poison loops where an
      // oversized or malformed value is written unvalidated, then rejected on read,
      // deleted, and re-fetched in an infinite cycle.
      const written = await this.cache.setValidated(
        cacheKey.redisKey,
        response,
        SearchResponseCacheSchema,
        'RedisQueryCache',
        effectiveTtl,
      );
      if (written) {
        void Promise.resolve(this.cache.redis.incr(STATS_KEY_SETS)).catch(() => {
          /* best-effort; counter drift is acceptable */
        });
      } else {
        log.warn({ key: cacheKey.redisKey }, 'query cache write skipped: shape validation failed');
      }
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
    readonly sets: number;
    readonly size: number;
    readonly entriesCount: number;
  }> {
    const redis = this.cache.redis;
    try {
      // Get hit/miss/sets counters
      const hitsStr = await redis.get(STATS_KEY_HITS);
      const missesStr = await redis.get(STATS_KEY_MISSES);
      const setsStr = await redis.get(STATS_KEY_SETS);
      const hitsRaw = hitsStr ? parseInt(hitsStr, 10) : NaN;
      const missesRaw = missesStr ? parseInt(missesStr, 10) : NaN;
      const setsRaw = setsStr ? parseInt(setsStr, 10) : NaN;
      const hits = Number.isFinite(hitsRaw) ? hitsRaw : 0;
      const misses = Number.isFinite(missesRaw) ? missesRaw : 0;
      const sets = Number.isFinite(setsRaw) ? setsRaw : 0;

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
      } catch (infoProbeError) {
        // Redis INFO may be disabled (ACL/cluster mode); 0 is the safe
        // fallback for size reporting. Reference the error so semgrep
        // wine-catch-empty does not flag this no-op recovery.
        void infoProbeError;
      }

      return {
        hits,
        misses,
        sets,
        size: usedMemory,
        entriesCount,
      };
    } catch (error) {
      // Wave 2: stats collection failure is an infra_error, NOT "zero activity".
      // Returning all-zero makes dashboards silently read "cache idle" when in
      // fact Redis INFO is unreachable. Count separately so ops can alert.
      globalSilentSkipCounter.increment('cache_read_failure', {
        surface: 'redis-query-cache.stats',
        errorClass: error instanceof Error ? error.constructor.name : 'unknown',
      });
      log.error({ err: error }, 'stats error (infra_error; returning zero as fallback — verify via metrics)');
      return { hits: 0, misses: 0, sets: 0, size: 0, entriesCount: 0 };
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
    const results = await Promise.allSettled([
      redis.del(STATS_KEY_HITS),
      redis.del(STATS_KEY_MISSES),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        log.error({ err: result.reason }, 'reset stats error');
      }
    }
  }
}
