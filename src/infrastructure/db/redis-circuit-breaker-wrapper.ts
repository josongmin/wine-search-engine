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
  type CircuitBreaker,
} from '../../domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../observability/circuit-breaker-registry.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'RedisCircuitBreakerWrapper' });

/** Circuit breaker thresholds for Redis — slightly more permissive than
 *  Vespa/embedding because transient Redis hiccups are common during
 *  deployments and should not immediately kill the cache layer. */
const REDIS_BREAKER_NAME = 'redis';
const REDIS_FAILURE_THRESHOLD = 5;
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
   * Read a key. Returns null (cache miss) when the breaker is open or
   * when the underlying Redis client throws. Failures trip the breaker.
   */
  async get(key: string): Promise<string | null> {
    if (this.breaker.state === 'OPEN') {
      return null;
    }
    try {
      return await this.breaker.execute(() => this.client.get(key));
    } catch (err) {
      log.debug({ err, key }, 'Redis get failed — treating as cache miss');
      return null;
    }
  }

  /**
   * Write a key/value pair. Silently dropped when the breaker is open.
   * Failures trip the breaker.
   */
  async set(key: string, value: string | number, options?: unknown): Promise<void> {
    if (this.breaker.state === 'OPEN') {
      return;
    }
    try {
      await this.breaker.execute(() => this.client.set(key, value, options));
    } catch (err) {
      log.debug({ err, key }, 'Redis set failed — cache write dropped');
    }
  }

  /**
   * Delete a key. Silently dropped when the breaker is open.
   */
  async del(key: string | string[]): Promise<void> {
    if (this.breaker.state === 'OPEN') {
      return;
    }
    try {
      await this.breaker.execute(() => this.client.del(key));
    } catch (err) {
      log.debug({ err, key }, 'Redis del failed — delete dropped');
    }
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
