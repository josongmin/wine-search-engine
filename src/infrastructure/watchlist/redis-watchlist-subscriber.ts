/**
 * Epic 17.1: Redis Watchlist Subscriber
 *
 * Subscribes to watchlist event channels using pub/sub pattern matching.
 * Requires a DEDICATED Redis connection (cannot issue commands while subscribed).
 */

import { createClient } from 'redis';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { config } from '../../config/env.js';
import {
  parseWatchlistChangeEvent,
  type WatchlistChangeEvent,
} from '../../domain/watchlist/model/watchlist-entry.js';
import type { RedisConfig } from '../db/redis-client.js';
import { globalSilentSkipCounter } from '../../observability/silent-skip-counters.js';

/**
 * Handler signature for watchlist change notifications.
 * Handlers are fired as floating promises; errors are caught internally.
 */
export type WatchlistEventHandler = (
  entityId: string,
  event: WatchlistChangeEvent,
) => Promise<void>;

export interface WatchlistSubscriberPort {
  start(handler: WatchlistEventHandler): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

/**
 * Wave 3 (fail-loud): poison/DLQ store for events that exhausted retry.
 *
 * Production should bind a durable PG-backed implementation; the default
 * in-memory store keeps unit tests honest and surfaces the count via
 * `size()` for diagnostics. A poisoned event is NOT lost: it becomes
 * visible to ops via the silent-skip counter `cache_write_failure`
 * (surface=watchlist_dlq) AND the durable store (when bound).
 */
export interface WatchlistPoisonStore {
  push(record: WatchlistPoisonRecord): Promise<void>;
  size(): Promise<number>;
}

export interface WatchlistPoisonRecord {
  readonly entityId: string;
  readonly rawPayload: string;
  readonly attempts: number;
  readonly lastError: string;
  readonly firstSeenAt: Date;
  readonly poisonedAt: Date;
}

/**
 * Default in-memory implementation. Suitable for tests and as a fallback
 * — production should bind a PG-backed store via DI.
 */
export class InMemoryWatchlistPoisonStore implements WatchlistPoisonStore {
  private readonly records: WatchlistPoisonRecord[] = [];
  async push(record: WatchlistPoisonRecord): Promise<void> {
    this.records.push(record);
  }
  async size(): Promise<number> {
    return this.records.length;
  }
  /** Test helper — production code MUST NOT iterate the live store. */
  snapshot(): readonly WatchlistPoisonRecord[] {
    return [...this.records];
  }
}

/** Default retry policy: 3 attempts with linear backoff (50ms, 150ms, 350ms). */
export const DEFAULT_HANDLER_RETRY_DELAYS_MS: readonly number[] = [50, 150, 350];

type RedisSubscriberClient = ReturnType<typeof createClient>;
type RedisSubscriberFactory = (redisConfig: RedisConfig) => RedisSubscriberClient;

const log = bootstrapLogger.child({ component: 'RedisWatchlistSubscriber' });

/**
 * Subscribes to watchlist event channels using pattern matching.
 * Maintains a DEDICATED subscriber connection for Redis pub/sub.
 */
export class RedisWatchlistSubscriber implements WatchlistSubscriberPort {
  private subscriber: RedisSubscriberClient | null = null;
  private running: boolean = false;
  private readonly poisonStore: WatchlistPoisonStore;
  private readonly retryDelaysMs: readonly number[];
  /** First-seen timestamp per entityId for in-flight events (cleared on success/poison). */
  private readonly firstSeenAt = new Map<string, Date>();

  constructor(
    private readonly redisConfig: RedisConfig = config.redis,
    private readonly createSubscriber: RedisSubscriberFactory = (redisConfig) =>
      createClient(redisConfig.url !== undefined ? { url: redisConfig.url } : {}),
    options?: {
      readonly poisonStore?: WatchlistPoisonStore;
      readonly retryDelaysMs?: readonly number[];
    },
  ) {
    this.poisonStore = options?.poisonStore ?? new InMemoryWatchlistPoisonStore();
    this.retryDelaysMs = options?.retryDelaysMs ?? DEFAULT_HANDLER_RETRY_DELAYS_MS;
  }

  /**
   * Starts the subscriber, listening for events on "watchlist:*" pattern.
   * Fires handler for each incoming event as a floating promise.
   * Handler errors are caught and logged internally.
   *
   * @param handler - Callback fired on each event (entityId, event).
   * @throws On connection failure.
   */
  async start(handler: WatchlistEventHandler): Promise<void> {
    if (this.running || this.subscriber !== null) {
      throw new Error('Subscriber already running');
    }

    // Create a dedicated subscriber connection. If anything below throws
    // before start() returns cleanly, we must tear down the half-initialised
    // client — otherwise the socket, the 'error' listener, and any in-flight
    // pSubscribe state are leaked and a subsequent start() would stack a new
    // client on top of the old one.
    const nextSubscriber = this.createSubscriber(this.redisConfig);
    const errorListener = (err: Error): void => {
      log.error({ err }, 'Redis subscriber connection error');
    };
    nextSubscriber.on('error', errorListener);

    try {
      await nextSubscriber.connect();

      // Listen for messages on "watchlist:*" pattern
      await nextSubscriber.pSubscribe('watchlist:*', (payload: string, channel: string) => {
        // Extract entityId from channel (format: "watchlist:{entityId}")
        const entityId = channel.slice('watchlist:'.length);

        // Fire handler as floating promise to avoid blocking the subscriber
        void this.handleEvent(entityId, payload, handler).catch((err: unknown) => {
          log.error({ err, entityId }, 'watchlist handler error');
        });
      });
    } catch (err) {
      // Best-effort cleanup of the half-open client so neither the socket
      // nor the 'error' listener leaks across failed start attempts.
      try {
        nextSubscriber.off('error', errorListener);
      } catch (listenerOffError) {
        // Client is being torn down anyway. Reference the error so semgrep
        // wine-catch-empty does not flag this best-effort recovery.
        void listenerOffError;
      }
      try {
        if (nextSubscriber.isOpen) {
          await nextSubscriber.quit();
        } else {
          nextSubscriber.destroy();
        }
      } catch (cleanupError) {
        // Secondary teardown failure — socket will be GC'd. Reference the
        // error so semgrep wine-catch-empty does not flag this.
        void cleanupError;
      }
      throw err;
    }

    this.subscriber = nextSubscriber;
    this.running = true;
  }

  /**
   * Stops the subscriber and closes the dedicated connection.
   */
  async stop(): Promise<void> {
    if (this.subscriber?.isOpen) {
      await this.subscriber.quit();
    }
    this.subscriber = null;
    this.running = false;
  }

  /**
   * Parses and invokes the handler for a received message.
   *
   * Wave 3 (fail-loud): handler failures are retried per `retryDelaysMs`
   * (default 50/150/350ms). When all attempts are exhausted, the event
   * is appended to the poison store (DLQ) and a `cache_write_failure`
   * counter is incremented with surface=`watchlist_dlq`. The subscriber
   * itself never crashes.
   */
  private async handleEvent(
    entityId: string,
    payload: string,
    handler: WatchlistEventHandler,
  ): Promise<void> {
    if (!this.firstSeenAt.has(entityId)) {
      this.firstSeenAt.set(entityId, new Date());
    }

    let lastError: unknown;
    let attempts = 0;
    const maxAttempts = this.retryDelaysMs.length + 1; // 1 initial + N retries

    for (let i = 0; i < maxAttempts; i++) {
      attempts = i + 1;
      try {
        const parsedPayload = JSON.parse(payload) as unknown;
        const event = parseWatchlistChangeEvent(parsedPayload);
        if (event === null) {
          throw new Error('Invalid watchlist event payload');
        }
        await handler(entityId, event);
        // Success — clear bookkeeping and return.
        this.firstSeenAt.delete(entityId);
        return;
      } catch (err: unknown) {
        lastError = err;
        log.warn(
          { err, entityId, attempt: attempts, maxAttempts },
          'watchlist handler attempt failed — will retry if attempts remain',
        );
      }
      // Backoff (only if more attempts remain).
      if (i < this.retryDelaysMs.length) {
        const delay = this.retryDelaysMs[i] ?? 0;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }

    // All retries exhausted → poison.
    const firstSeen = this.firstSeenAt.get(entityId) ?? new Date();
    this.firstSeenAt.delete(entityId);
    const lastErrorMsg = lastError instanceof Error ? lastError.message : String(lastError);
    try {
      await this.poisonStore.push({
        entityId,
        rawPayload: payload,
        attempts,
        lastError: lastErrorMsg,
        firstSeenAt: firstSeen,
        poisonedAt: new Date(),
      });
    } catch (poisonErr) {
      // Even DLQ write failed — log loudly. Loss of a poison record is
      // a critical observability gap so we increment a separate counter.
      globalSilentSkipCounter.increment('cache_write_failure', {
        surface: 'watchlist_dlq.push',
        errorClass: poisonErr instanceof Error ? poisonErr.constructor.name : 'unknown',
      });
      log.error(
        { err: poisonErr, entityId, attempts },
        'watchlist poison/DLQ write FAILED — event lost',
      );
    }
    globalSilentSkipCounter.increment('cache_write_failure', {
      surface: 'watchlist_dlq',
      errorClass: lastError instanceof Error ? lastError.constructor.name : 'unknown',
    });
    log.error(
      { entityId, attempts, lastError: lastErrorMsg },
      'watchlist event poisoned after retry exhaustion — appended to DLQ',
    );
  }

  /** Test helper / ops introspection. */
  async poisonStoreSize(): Promise<number> {
    return this.poisonStore.size();
  }

  /**
   * Returns true if the subscriber is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
