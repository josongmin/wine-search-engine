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

import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { EmbeddingCacheKey } from '../../domain/performance/model/cache-key.js';
import type { EmbeddingCachePort } from '../../domain/performance/port/embedding-cache.port.js';
import { deleteRedisKeysMatchingPattern } from '../db/redis-delete-by-pattern.js';
import type { RedisClient } from '../db/redis-client.js';

const log = bootstrapLogger.child({ component: 'RedisEmbeddingCache' });

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
  private readonly statsKeyHits = 'cache:stats:embedding:hits';
  private readonly statsKeyMisses = 'cache:stats:embedding:misses';

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /**
   * Single source of truth for poisoned-entry handling: bumps the miss counter,
   * fires-and-forgets a DEL on the key, and returns undefined. Used by all three
   * failure paths (parse error, shape error, element error) so they stay consistent.
   */
  private async handlePoisoned(
    cacheKey: EmbeddingCacheKey,
    reason: string,
  ): Promise<undefined> {
    log.warn({ key: cacheKey.redisKey, reason }, 'embedding cache poisoned; treating as miss');
    // Wrap miss counter + delete in try/catch so a synchronous redis throw
    // (closed client, broken socket) doesn't reject this promise and propagate
    // up to the caller — defeating the "treat as miss" semantics.
    try {
      await this.redis.incr(this.statsKeyMisses);
    } catch {
      // metric increment is best-effort
    }
    try {
      await this.redis.del(cacheKey.redisKey);
    } catch {
      // delete is best-effort; the entry's TTL will eventually clean it up
    }
    return undefined;
  }

  async get(cacheKey: EmbeddingCacheKey): Promise<readonly number[] | undefined> {
    let cached: string | null;
    try {
      cached = await this.redis.get(cacheKey.redisKey);
    } catch (error) {
      log.error({ err: error }, 'redis get error');
      await this.redis.incr(this.statsKeyMisses);
      return undefined;
    }

    if (cached === null) {
      await this.redis.incr(this.statsKeyMisses);
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cached);
    } catch {
      // Non-JSON poisoning: also delete so reads don't keep paying.
      return this.handlePoisoned(cacheKey, 'json_parse_error');
    }

    // Validate shape: must be a non-empty array of finite numbers.
    // CRITICAL: increment hits ONLY after validation passes; otherwise
    // the hit-rate metric is inflated by poisoned reads.
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return this.handlePoisoned(cacheKey, 'not_an_array_or_empty');
    }
    for (const v of parsed) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return this.handlePoisoned(cacheKey, 'non_numeric_element');
      }
    }
    await this.redis.incr(this.statsKeyHits);
    return parsed as readonly number[];
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
      log.error({ err: error }, 'write error');
    }
  }

  async delete(cacheKey: EmbeddingCacheKey): Promise<void> {
    try {
      await this.redis.del(cacheKey.redisKey);
    } catch (error) {
      log.error({ err: error }, 'delete error');
    }
  }

  async deleteByModel(modelId: string): Promise<number> {
    try {
      // Escape Redis glob metacharacters in modelId to prevent pattern injection
      const safeModelId = modelId.replace(/[*?[\]\\]/g, '\\$&');
      return await deleteRedisKeysMatchingPattern(
        this.redis,
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
            const size = await this.redis.strLen(keyStr);
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
      log.error({ err: error }, 'stats error');
      return { hits: 0, misses: 0, size: 0, entriesCount: 0 };
    }
  }

  async clear(): Promise<number> {
    try {
      return await deleteRedisKeysMatchingPattern(this.redis, 'embedding:*');
    } catch (error) {
      log.error({ err: error }, 'clear error');
      return 0;
    }
  }
}
