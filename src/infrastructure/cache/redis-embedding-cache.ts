/**
 * Redis-backed Embedding Cache Implementation.
 *
 * Stores dense embedding vectors as JSON for simplicity and compatibility.
 * Uses {@link RedisCache.getValidatedWithStats} for the read → parse →
 * validate → stats pipeline, eliminating duplicated poisoned-entry handling.
 *
 * Implements EmbeddingCachePort from domain (dependency inversion).
 *
 * Trade-off: JSON is ~2x larger than binary, but:
 * - Simpler implementation (no binary serialization)
 * - Compatible with node-redis JSON storage
 * - Still memory-efficient for typical embedding sizes (384-1024 dims)
 */

import { z } from 'zod';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { EmbeddingCacheKey } from '../../domain/performance/model/cache-key.js';
import type { EmbeddingCachePort } from '../../domain/performance/port/embedding-cache.port.js';
import { deleteRedisKeysMatchingPattern } from '../db/redis-delete-by-pattern.js';
import { RedisCache } from '../adapter/redis-cache.js';
import type { GetValidatedStatsOptions } from '../adapter/redis-cache.js';
import type { RedisClient } from '../db/redis-client.js';
import { globalSilentSkipCounter } from '../../domain/observability/silent-skip-counters.js';
import { CACHE_TTL_SECONDS } from './cache-ttl-config.js';

const log = bootstrapLogger.child({ component: 'RedisEmbeddingCache' });

/**
 * Zod schema for cached embedding vectors: non-empty array of finite numbers.
 * Replaces the manual isArray + per-element loop validation that was previously
 * inlined in the get() method.
 *
 * Upper bound: 4096 dims covers production OpenAI models (text-embedding-3-small at 1024 by truncation, text-embedding-3-large at 3072).
 */
const MAX_EMBEDDING_DIMENSIONS = 4096;
const EmbeddingVectorSchema = z.array(z.number().finite()).min(1).max(MAX_EMBEDDING_DIMENSIONS);

const STATS_KEY_HITS = 'cache:stats:embedding:hits';
const STATS_KEY_MISSES = 'cache:stats:embedding:misses';
const STATS_KEY_SETS = 'cache:stats:embedding:sets';

const EMBEDDING_STATS: GetValidatedStatsOptions = {
  statsKeyHits: STATS_KEY_HITS,
  statsKeyMisses: STATS_KEY_MISSES,
  logComponent: 'RedisEmbeddingCache',
};

/**
 * Redis embedding cache: Store dense vectors efficiently.
 *
 * Storage strategy:
 * - Key: Deterministic Redis key from EmbeddingCacheKey (e.g., "embedding:text-embedding-3-small:abc123")
 * - Value: JSON-serialized Float32 array
 * - TTL: 7200s (embeddings very stable, only change on model upgrade)
 */
export class RedisEmbeddingCache implements EmbeddingCachePort {
  private readonly cache: RedisCache;

  constructor(redis: RedisClient) {
    // defaultTtlSeconds unused (TTL always explicit), but required by RedisCache.
    this.cache = new RedisCache(redis, 0);
  }

  async get(cacheKey: EmbeddingCacheKey): Promise<readonly number[] | undefined> {
    const result = await this.cache.getValidatedWithStats(
      cacheKey.redisKey,
      EmbeddingVectorSchema,
      EMBEDDING_STATS,
    );
    return result ?? undefined;
  }

  async set(
    cacheKey: EmbeddingCacheKey,
    rawEmbedding: readonly number[],
    ttlSeconds?: number,
  ): Promise<void> {
    // Default TTL (E1: infra.redis-cache-layer 3→4) — when caller omits TTL,
    // use the documented per-cache default from the SSoT config.
    const effectiveTtl = ttlSeconds ?? CACHE_TTL_SECONDS.EMBEDDING;
    try {
      // Coerce to plain Array before JSON.stringify — ML backends often
      // return Float32Array whose JSON representation is {"0":...} (an
      // object, not array), which the read path rejects as poisoned.
      const embedding = Array.isArray(rawEmbedding) ? rawEmbedding : Array.from(rawEmbedding);
      // Write-time Zod validation (E5-T11): prevents cache-poison loops where an
      // oversized or malformed embedding is written unvalidated, then rejected on read,
      // deleted, and re-fetched in an infinite cycle.
      const written = await this.cache.setValidated(
        cacheKey.redisKey,
        embedding,
        EmbeddingVectorSchema,
        'RedisEmbeddingCache',
        effectiveTtl,
      );
      if (written) {
        // Best-effort sets-counter increment (telemetry hook).
        void Promise.resolve(this.cache.redis.incr(STATS_KEY_SETS)).catch(() => {
          /* best-effort; counter drift is acceptable */
        });
      } else {
        globalSilentSkipCounter.increment('cache_write_failure', {
          surface: 'embedding',
          errorClass: 'shape_validation',
        });
        log.warn({ key: cacheKey.redisKey, dims: embedding.length }, 'embedding cache write skipped: shape validation failed');
      }
    } catch (error) {
      globalSilentSkipCounter.increment('cache_write_failure', {
        surface: 'embedding.write',
        errorClass: error instanceof Error ? error.constructor.name : 'unknown',
      });
      log.error({ err: error }, 'write error');
    }
  }

  async delete(cacheKey: EmbeddingCacheKey): Promise<void> {
    try {
      await this.cache.del(cacheKey.redisKey);
    } catch (error) {
      globalSilentSkipCounter.increment('cache_write_failure', {
        surface: 'embedding.delete',
        errorClass: error instanceof Error ? error.constructor.name : 'unknown',
      });
      log.error({ err: error }, 'delete error');
    }
  }

  async deleteByModel(modelId: string): Promise<number> {
    try {
      // Escape Redis glob metacharacters in modelId to prevent pattern injection
      const safeModelId = modelId.replace(/[*?[\]\\]/g, '\\$&');
      return await deleteRedisKeysMatchingPattern(
        this.cache.redis,
        `embedding:${safeModelId}:*`,
      );
    } catch (error) {
      log.error({ err: error }, 'delete by model error');
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

      // Count entries and compute size
      let entriesCount = 0;
      let cursorSize = 0;
      for await (const key of redis.scanIterator({
        MATCH: 'embedding:*',
        COUNT: 100,
      })) {
        const keyStr = String(key);
        if (!keyStr.startsWith('embedding:cache:stats')) {
          entriesCount++;
          try {
            const size = await redis.strLen(keyStr);
            if (typeof size === 'number') {
              cursorSize += size;
            }
          } catch (sizeProbeError) {
            // best-effort size accumulation; individual key failures (expired
            // between SCAN and STRLEN) are harmless. Reference the error so
            // semgrep wine-catch-empty does not flag this no-op recovery.
            void sizeProbeError;
          }
        }
      }

      return {
        hits,
        misses,
        sets,
        size: cursorSize,
        entriesCount,
      };
    } catch (error) {
      log.error({ err: error }, 'stats error');
      return { hits: 0, misses: 0, sets: 0, size: 0, entriesCount: 0 };
    }
  }

  async clear(): Promise<number> {
    try {
      return await deleteRedisKeysMatchingPattern(this.cache.redis, 'embedding:*');
    } catch (error) {
      log.error({ err: error }, 'clear error');
      return 0;
    }
  }
}
