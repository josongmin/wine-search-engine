/**
 * Redis circuit breaker wrapper (E3-T4: W2-BUG-03).
 *
 * Wraps a RedisClient with a circuit breaker that opens after repeated
 * Redis failures. When the breaker is open, all read operations return
 * null (cache-miss semantics) and write operations are silently dropped,
 * so the search pipeline degrades gracefully rather than crashing.
 *
 * This wrapper is intentionally minimal — it only gates the operations
 * used by the hot retrieval path (get/set/del/ping). Rarely-called
 * housekeeping methods (flushAll, etc.) are not wrapped.
 */

import {
  createCircuitBreaker,
  DEFAULT_BREAKER_FAILURE_THRESHOLD,
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../domain/observability/circuit-breaker-registry.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import {
  cacheBreakerOpen,
  cacheHit,
  cacheInfraError,
  cacheMiss,
  toLegacyGetValue,
  writeBreakerOpen,
  writeInfraError,
  writeOk,
  type CacheGetResult,
  type CacheWriteResult,
} from '../../domain/performance/port/cache-result.js';
import { globalSilentSkipCounter as silentSkipCounter } from '../../domain/observability/silent-skip-counters.js';

const log = bootstrapLogger.child({ component: 'RedisCircuitBreakerWrapper' });

/** Circuit breaker thresholds for Redis — slightly more permissive than
 *  Vespa/embedding because transient Redis hiccups are common during
 *  deployments and should not immediately kill the cache layer. */
const REDIS_BREAKER_NAME = 'redis';
const REDIS_FAILURE_THRESHOLD = DEFAULT_BREAKER_FAILURE_THRESHOLD;
const REDIS_RECOVERY_TIMEOUT_MS = 15_000;
const REDIS_HALF_OPEN_MAX = 3;

/**
 * Minimal surface of RedisClient that this wrapper needs to intercept.
 * Using a structural type here avoids a hard import of the full redis
 * package, which keeps test setup lightweight (no real Redis connection).
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | number, options?: unknown): Promise<unknown>;
  del(key: string | string[]): Promise<unknown>;
  ping(): Promise<string>;
}

/**
 * Wraps a RedisClientLike with a circuit breaker.
 *
 * Exposes the same minimal interface as RedisClientLike so it can be
 * used as a drop-in replacement wherever a thin Redis façade is needed.
 */
export class RedisCircuitBreakerWrapper {
  private readonly breaker: CircuitBreaker;

  constructor(private readonly client: RedisClientLike) {
    this.breaker = createCircuitBreaker({
      name: REDIS_BREAKER_NAME,
      failureThreshold: REDIS_FAILURE_THRESHOLD,
      recoveryTimeoutMs: REDIS_RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: REDIS_HALF_OPEN_MAX,
    });
    globalCircuitBreakerRegistry.register(REDIS_BREAKER_NAME, this.breaker);
  }

  /** Force the breaker OPEN (test helper / manual admin override). */
  forceOpen(): void {
    this.breaker.forceOpen();
  }

  /** Force the breaker CLOSED (test helper / manual admin override). */
  forceClose(): void {
    this.breaker.forceClose();
  }

  /**
   * Wave 2 typed read. Distinguishes miss / breaker_open / infra_error
   * so callers can attribute observability correctly.
   */
  async getTyped(key: string): Promise<CacheGetResult<string>> {
    if (this.breaker.state === 'OPEN') {
      silentSkipCounter.increment('cache_read_failure', { reason: 'breaker_open' });
      return cacheBreakerOpen();
    }
    try {
      const raw = await this.breaker.execute(() => this.client.get(key));
      if (raw === null) {
        return cacheMiss();
      }
      return cacheHit(raw);
    } catch (err) {
      log.debug({ err, key }, 'Redis get failed — treating as cache infra_error');
      silentSkipCounter.increment('cache_read_failure', {
        reason: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return cacheInfraError(err);
    }
  }

  /**
   * Legacy read — collapses typed result to `string | null`. Prefer getTyped()
   * at ops-sensitive call sites.
   */
  async get(key: string): Promise<string | null> {
    return toLegacyGetValue(await this.getTyped(key));
  }

  /**
   * Wave 2 typed write.
   */
  async setTyped(key: string, value: string | number, options?: unknown): Promise<CacheWriteResult> {
    if (this.breaker.state === 'OPEN') {
      silentSkipCounter.increment('cache_write_failure', { reason: 'breaker_open' });
      return writeBreakerOpen();
    }
    try {
      await this.breaker.execute(() => this.client.set(key, value, options));
      return writeOk();
    } catch (err) {
      log.debug({ err, key }, 'Redis set failed — cache write dropped');
      silentSkipCounter.increment('cache_write_failure', {
        reason: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return writeInfraError(err);
    }
  }

  async set(key: string, value: string | number, options?: unknown): Promise<void> {
    await this.setTyped(key, value, options);
  }

  async delTyped(key: string | string[]): Promise<CacheWriteResult> {
    if (this.breaker.state === 'OPEN') {
      silentSkipCounter.increment('cache_write_failure', { reason: 'breaker_open' });
      return writeBreakerOpen();
    }
    try {
      await this.breaker.execute(() => this.client.del(key));
      return writeOk();
    } catch (err) {
      log.debug({ err, key }, 'Redis del failed — delete dropped');
      silentSkipCounter.increment('cache_write_failure', {
        reason: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return writeInfraError(err);
    }
  }

  async del(key: string | string[]): Promise<void> {
    await this.delTyped(key);
  }

  /**
   * Health-check ping. Returns false when the breaker is open.
   */
  async ping(): Promise<boolean> {
    if (this.breaker.state === 'OPEN') {
      return false;
    }
    try {
      const reply = await this.breaker.execute(() => this.client.ping());
      return reply === 'PONG';
    } catch {
      return false;
    }
  }
}
