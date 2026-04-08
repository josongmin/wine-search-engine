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
 *   matching the convention in {@link RedisEmbeddingCache}.
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
import type { RedisClient } from '../db/redis-client.js';

const log = bootstrapLogger.child({ component: 'RedisPhraseCache' });

const REDIS_KEY_PREFIX = 'phrase:';
const STATS_KEY_HITS = 'cache:stats:phrase:hits';
const STATS_KEY_MISSES = 'cache:stats:phrase:misses';

/** Minimum TTL — Redis rejects EX <= 0; we silently clamp to keep callers safe. */
const PHRASE_CACHE_MIN_TTL_SECONDS = 1;
/** Maximum TTL — 7 days. Anything longer is almost certainly a bug. */
const PHRASE_CACHE_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export class RedisPhraseCache implements PhraseCachePort {
  constructor(private readonly redis: RedisClient) {}

  async get(phrase: string): Promise<LlmConstraintItem[] | null> {
    try {
      const raw = await this.redis.get(REDIS_KEY_PREFIX + phrase);
      if (raw === null) {
        // Fire-and-forget stats; never block the cache path on counter errors.
        this.redis.incr(STATS_KEY_MISSES).catch(() => undefined);
        return null;
      }
      const parsed: unknown = JSON.parse(raw);
      // Re-validate to defend against schema drift across deploys: a key
      // written by an old binary may not match the current item shape.
      // The cost is bounded by MAX_LLM_PHRASES (=20) per request, so the
      // schema-drift insurance is worth the per-hit overhead.
      const validated = LlmConstraintResponseSchema.safeParse(parsed);
      if (!validated.success) {
        log.warn(
          { phrase, issues: validated.error.issues.slice(0, 3) },
          'cached phrase entry failed schema validation; treating as miss',
        );
        this.redis.incr(STATS_KEY_MISSES).catch(() => undefined);
        return null;
      }
      this.redis.incr(STATS_KEY_HITS).catch(() => undefined);
      return validated.data;
    } catch (err) {
      log.warn({ err, phrase }, 'phrase cache read error; treating as miss');
      this.redis.incr(STATS_KEY_MISSES).catch(() => undefined);
      return null;
    }
  }

  async set(
    phrase: string,
    items: LlmConstraintItem[],
    ttlSeconds: number,
  ): Promise<void> {
    const safeTtl = clampTtl(ttlSeconds);
    try {
      const serialized = JSON.stringify(items);
      await this.redis.set(REDIS_KEY_PREFIX + phrase, serialized, { EX: safeTtl });
    } catch (err) {
      log.warn({ err, phrase }, 'phrase cache write error; ignoring');
    }
  }

  /**
   * Operator-facing hit/miss counters. Mirrors RedisEmbeddingCache.getStats().
   */
  async getStats(): Promise<{ hits: number; misses: number }> {
    try {
      const [hitsRaw, missesRaw] = await Promise.all([
        this.redis.get(STATS_KEY_HITS),
        this.redis.get(STATS_KEY_MISSES),
      ]);
      return {
        hits: hitsRaw === null ? 0 : Number.parseInt(hitsRaw, 10) || 0,
        misses: missesRaw === null ? 0 : Number.parseInt(missesRaw, 10) || 0,
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
