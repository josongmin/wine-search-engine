import type { ZodType } from 'zod';
import { deleteRedisKeysMatchingPattern } from '../db/redis-delete-by-pattern.js';
import type { RedisClient } from '../db/redis-client.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'RedisCache' });

/**
 * Fire-and-forget INCR / DEL helpers used by the validated read pipeline.
 *
 * The cache contract is "treat as miss on any infra failure" — counter and
 * housekeeping side effects must NEVER throw into the caller. We funnel all
 * such best-effort operations through these helpers so the call sites stay
 * single-line and so semgrep `wine-catch-empty` does not flag inline
 * `try { ... } catch {}` swallowing.
 *
 * Errors are logged at `debug` level so operators can opt in to observability
 * without paying log overhead in the hot path.
 */
async function bestEffortIncr(client: RedisClient, key: string): Promise<void> {
  try {
    await client.incr(key);
  } catch (err) {
    log.debug({ err, key, op: 'incr' }, 'best-effort redis op failed; ignoring');
  }
}

async function bestEffortDel(client: RedisClient, key: string): Promise<void> {
  try {
    await client.del(key);
  } catch (err) {
    log.debug({ err, key, op: 'del' }, 'best-effort redis op failed; ignoring');
  }
}

/**
 * Options for {@link RedisCache.getValidatedWithStats} that enable per-domain
 * hit/miss tracking and structured logging.
 */
export interface GetValidatedStatsOptions {
  /** Redis key incremented on cache hit (after successful validation). */
  readonly statsKeyHits: string;
  /** Redis key incremented on cache miss (including poisoned entries). */
  readonly statsKeyMisses: string;
  /** Logging component name for poisoned-entry warnings. */
  readonly logComponent: string;
}

export class RedisCache {
  constructor(
    private readonly client: RedisClient,
    private readonly defaultTtlSeconds: number,
  ) {}

  /** Expose the underlying Redis client for domain-specific operations. */
  get redis(): RedisClient {
    return this.client;
  }

  /**
   * Validated cache read. Returns null on miss, parse error, or shape mismatch.
   * Logs (without raising) when a cache entry has the wrong shape so operators
   * can detect schema drift / cache poisoning.
   */
  async getValidated<T>(key: string, schema: ZodType<T>): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw == null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      log.warn(
        { key, issues: result.error.issues.slice(0, 3) },
        'redis cache entry has unexpected shape; treating as miss',
      );
      // Best-effort: delete the poisoned entry so subsequent reads don't keep paying.
      void this.client.del(key).catch(() => undefined);
      return null;
    }
    return result.data;
  }

  /**
   * Validated cache read **with hit/miss stats tracking**.
   *
   * Single source of truth for the read → parse → validate → stats pipeline
   * that every domain-specific cache needs. Handles:
   * 1. Redis GET (returns null on miss after incrementing miss counter)
   * 2. JSON.parse (deletes poisoned entry + miss counter on failure)
   * 3. Zod validation (deletes schema-drifted entry + miss counter on failure)
   * 4. Hit counter increment only after successful validation
   *
   * All Redis errors (GET, INCR, DEL) are swallowed to preserve "treat as miss"
   * semantics — callers never see infrastructure errors.
   */
  async getValidatedWithStats<T>(
    key: string,
    schema: ZodType<T>,
    stats: GetValidatedStatsOptions,
  ): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await this.client.get(key);
    } catch (error) {
      log.error({ err: error, component: stats.logComponent }, 'redis get error');
      await bestEffortIncr(this.client, stats.statsKeyMisses);
      return null;
    }

    if (raw === null) {
      await bestEffortIncr(this.client, stats.statsKeyMisses);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn(
        { key, reason: 'json_parse_error', component: stats.logComponent },
        'cache entry poisoned (invalid JSON); treating as miss',
      );
      await bestEffortIncr(this.client, stats.statsKeyMisses);
      await bestEffortDel(this.client, key);
      return null;
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      log.warn(
        { key, issues: result.error.issues.slice(0, 3), component: stats.logComponent },
        'cache entry poisoned (schema mismatch); treating as miss',
      );
      await bestEffortIncr(this.client, stats.statsKeyMisses);
      await bestEffortDel(this.client, key);
      return null;
    }

    await bestEffortIncr(this.client, stats.statsKeyHits);
    return result.data;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    // Guard: Redis rejects EX ≤ 0 with a protocol error. A TTL of 0 often
    // means the caller forgot to pass an explicit TTL and defaultTtlSeconds
    // was initialized to 0 (the "always explicit" sentinel). Throw early so
    // the data pipeline bug surfaces immediately rather than as a Redis error.
    if (ttl <= 0) {
      throw new Error(`RedisCache.set: TTL must be > 0, got ${String(ttl)} for key "${key}"`);
    }
    const serialized = JSON.stringify(value);
    await this.client.set(key, serialized, { EX: ttl });
  }

  /**
   * Write with pre-flight schema validation.
   * Prevents cache-poison loops where an oversized value is written unvalidated,
   * then rejected on read by `getValidatedWithStats`, deleted, and re-fetched
   * in an infinite cycle.
   *
   * Returns `true` if the write succeeded, `false` if validation rejected the value.
   */
  async setValidated<T>(
    key: string,
    value: unknown,
    schema: ZodType<T>,
    logComponent: string,
    ttlSeconds?: number,
  ): Promise<boolean> {
    const result = schema.safeParse(value);
    if (!result.success) {
      log.warn(
        { component: logComponent, key, issues: result.error.issues.slice(0, 3) },
        'cache write rejected (schema validation failed)',
      );
      return false;
    }
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    await deleteRedisKeysMatchingPattern(this.client, pattern);
  }
}
