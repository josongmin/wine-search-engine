/**
 * Redis-backed PhraseCachePort implementation.
 *
 * Used by LlmNLMapper to memoize per-phrase LLM constraint extraction
 * results so common phrases (including no-match phrases via negative entries)
 * skip the LLM call entirely.
 *
 * Storage:
 * - Key: `phrase:{namespaced-phrase}` where the namespaced-phrase is what the
 *   consumer passes — LlmNLMapper namespaces by `${LLM_MAPPING_VERSION}:`.
 * - Value: JSON-serialized LlmConstraintItem[] (empty array = negative cache hit)
 * - TTL: clamped to [PHRASE_CACHE_MIN_TTL_SECONDS, PHRASE_CACHE_MAX_TTL_SECONDS]
 *
 * Observability:
 * - hit/miss counters live in Redis (`cache:stats:phrase:hits|misses`)
 *   via {@link RedisCache.getValidatedWithStats}.
 * - getStats() exposes hit/miss/entries for /metrics consumers.
 *
 * Failure mode: All Redis errors are swallowed and surfaced as cache misses
 * (get returns null) or no-ops (set). LlmNLMapper falls through to the LLM,
 * preserving correctness at the cost of an extra call.
 */

import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import type { PhraseCachePort } from '../../domain/attribute/port/phrase-cache.port.js';
import type { LlmConstraintItem } from '../../domain/attribute/model/llm-constraint-schema.js';
import { LlmConstraintResponseSchema } from '../../domain/attribute/model/llm-constraint-schema.js';
import { RedisCache } from '../adapter/redis-cache.js';
import type { GetValidatedStatsOptions } from '../adapter/redis-cache.js';
import type { RedisClient } from '../db/redis-client.js';

const log = bootstrapLogger.child({ component: 'RedisPhraseCache' });

const REDIS_KEY_PREFIX = 'phrase:';
const STATS_KEY_HITS = 'cache:stats:phrase:hits';
const STATS_KEY_MISSES = 'cache:stats:phrase:misses';

/** Minimum TTL — Redis rejects EX <= 0; we silently clamp to keep callers safe. */
const PHRASE_CACHE_MIN_TTL_SECONDS = 1;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const PHRASE_CACHE_MAX_TTL_DAYS = 7;
/** Maximum TTL — 7 days. Anything longer is almost certainly a bug. */
const PHRASE_CACHE_MAX_TTL_SECONDS =
  PHRASE_CACHE_MAX_TTL_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE;

const PHRASE_STATS: GetValidatedStatsOptions = {
  statsKeyHits: STATS_KEY_HITS,
  statsKeyMisses: STATS_KEY_MISSES,
  logComponent: 'RedisPhraseCache',
};

export class RedisPhraseCache implements PhraseCachePort {
  private readonly cache: RedisCache;

  constructor(redis: RedisClient) {
    // defaultTtlSeconds is unused for phrase cache (TTL always explicit), but required by RedisCache.
    this.cache = new RedisCache(redis, 0);
  }

  async get(phrase: string): Promise<LlmConstraintItem[] | null> {
    return this.cache.getValidatedWithStats(
      REDIS_KEY_PREFIX + phrase,
      LlmConstraintResponseSchema,
      PHRASE_STATS,
    );
  }

  async set(
    phrase: string,
    items: LlmConstraintItem[],
    ttlSeconds: number,
  ): Promise<void> {
    const safeTtl = clampTtl(ttlSeconds);
    try {
      await this.cache.setValidated(
        REDIS_KEY_PREFIX + phrase,
        items,
        LlmConstraintResponseSchema,
        'RedisPhraseCache',
        safeTtl,
      );
    } catch (err) {
      log.warn({ err, phrase }, 'phrase cache write error; ignoring');
    }
  }

  /**
   * Operator-facing hit/miss counters.
   */
  async getStats(): Promise<{ hits: number; misses: number }> {
    try {
      const redis = this.cache.redis;
      const [hitsRaw, missesRaw] = await Promise.all([
        redis.get(STATS_KEY_HITS),
        redis.get(STATS_KEY_MISSES),
      ]);
      const hitsInt = hitsRaw === null ? NaN : Number.parseInt(hitsRaw, 10);
      const missesInt = missesRaw === null ? NaN : Number.parseInt(missesRaw, 10);
      return {
        hits: Number.isFinite(hitsInt) ? hitsInt : 0,
        misses: Number.isFinite(missesInt) ? missesInt : 0,
      };
    } catch (err) {
      log.warn({ err }, 'phrase cache stats read error');
      return { hits: 0, misses: 0 };
    }
  }
}

function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return PHRASE_CACHE_MIN_TTL_SECONDS;
  return Math.min(
    PHRASE_CACHE_MAX_TTL_SECONDS,
    Math.max(PHRASE_CACHE_MIN_TTL_SECONDS, Math.floor(ttlSeconds)),
  );
}
