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

import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import type { PhraseCachePort } from '../../domain/attribute/port/phrase-cache.port.js';
import type { LlmConstraintItem } from '../../domain/attribute/model/llm-constraint-schema.js';
import { LlmConstraintResponseSchema } from '../../domain/attribute/model/llm-constraint-schema.js';
import { RedisCache } from '../adapter/redis-cache.js';
import type { GetValidatedStatsOptions } from '../adapter/redis-cache.js';
import type { RedisClient } from '../db/redis-client.js';
import { HOURS_PER_DAY, SECONDS_PER_MINUTE, MINUTES_PER_HOUR } from '../../domain/shared/utils/time-units.js';
import { CACHE_TTL_SECONDS } from './cache-ttl-config.js';

const log = bootstrapLogger.child({ component: 'RedisPhraseCache' });

const REDIS_KEY_PREFIX = 'phrase:';
const STATS_KEY_HITS = 'cache:stats:phrase:hits';
const STATS_KEY_MISSES = 'cache:stats:phrase:misses';
const STATS_KEY_SETS = 'cache:stats:phrase:sets';

/** Minimum TTL — Redis rejects EX <= 0; we silently clamp to keep callers safe. */
const PHRASE_CACHE_MIN_TTL_SECONDS = 1;
// SECONDS_PER_MINUTE, MINUTES_PER_HOUR, HOURS_PER_DAY imported from SSoT: time-units.ts
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
    ttlSeconds?: number,
  ): Promise<void> {
    // Default TTL (E1: infra.redis-cache-layer 3→4) — when caller omits TTL,
    // use the documented per-cache default from the SSoT config.
    const requestedTtl = ttlSeconds ?? CACHE_TTL_SECONDS.PHRASE;
    const safeTtl = clampTtl(requestedTtl);
    try {
      const written = await this.cache.setValidated(
        REDIS_KEY_PREFIX + phrase,
        items,
        LlmConstraintResponseSchema,
        'RedisPhraseCache',
        safeTtl,
      );
      if (written) {
        void Promise.resolve(this.cache.redis.incr(STATS_KEY_SETS)).catch(() => {
          /* best-effort; counter drift is acceptable */
        });
      }
    } catch (err) {
      log.warn({ err, phrase }, 'phrase cache write error; ignoring');
    }
  }

  /**
   * Operator-facing hit/miss/sets counters.
   *
   * `sets` was added in the E1 telemetry-hook bump (infra.redis-cache-layer
   * maturity 3 → 4) so operators can compute write-amplification and
   * hit-rate independently.
   */
  async getStats(): Promise<{ hits: number; misses: number; sets: number }> {
    try {
      const redis = this.cache.redis;
      const [hitsRaw, missesRaw, setsRaw] = await Promise.all([
        redis.get(STATS_KEY_HITS),
        redis.get(STATS_KEY_MISSES),
        redis.get(STATS_KEY_SETS),
      ]);
      const hitsInt = hitsRaw === null ? NaN : Number.parseInt(hitsRaw, 10);
      const missesInt = missesRaw === null ? NaN : Number.parseInt(missesRaw, 10);
      const setsInt = setsRaw === null ? NaN : Number.parseInt(setsRaw, 10);
      return {
        hits: Number.isFinite(hitsInt) ? hitsInt : 0,
        misses: Number.isFinite(missesInt) ? missesInt : 0,
        sets: Number.isFinite(setsInt) ? setsInt : 0,
      };
    } catch (err) {
      log.warn({ err }, 'phrase cache stats read error');
      return { hits: 0, misses: 0, sets: 0 };
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
