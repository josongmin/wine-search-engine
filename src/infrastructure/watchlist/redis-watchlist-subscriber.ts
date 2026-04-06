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

  constructor(
    private readonly redisConfig: RedisConfig = config.redis,
    private readonly createSubscriber: RedisSubscriberFactory = (redisConfig) =>
      createClient({ url: redisConfig.url }),
  ) {}

  /**
   * Starts the subscriber, listening for events on "watchlist:*" pattern.
   * Fires handler for each incoming event as a floating promise.
   * Handler errors are caught and logged internally.
   *
   * @param handler - Callback fired on each event (entityId, event).
   * @throws On connection failure.
   */
  async start(handler: WatchlistEventHandler): Promise<void> {
    if (this.running) {
      throw new Error('Subscriber already running');
    }

    // Create a dedicated subscriber connection
    this.subscriber = this.createSubscriber(this.redisConfig);
    this.subscriber.on('error', (err: Error) => {
      log.error({ err }, 'Redis subscriber connection error');
    });

    await this.subscriber.connect();
    this.running = true;

    // Listen for messages on "watchlist:*" pattern
    await this.subscriber.pSubscribe('watchlist:*', (payload: string, channel: string) => {
      // Extract entityId from channel (format: "watchlist:{entityId}")
      const entityId = channel.slice('watchlist:'.length);

      // Fire handler as floating promise to avoid blocking the subscriber
      void this.handleEvent(entityId, payload, handler).catch((err: unknown) => {
        log.error({ err, entityId }, 'watchlist handler error');
      });
    });
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
   * Errors are caught and do NOT crash the subscriber.
   */
  private async handleEvent(
    entityId: string,
    payload: string,
    handler: WatchlistEventHandler,
  ): Promise<void> {
    try {
      const parsedPayload = JSON.parse(payload) as unknown;
      const event = parseWatchlistChangeEvent(parsedPayload);
      if (event === null) {
        throw new Error('Invalid watchlist event payload');
      }
      await handler(entityId, event);
    } catch (err: unknown) {
      // Prevent handler errors from propagating
      log.error({ err, entityId }, 'failed to process watchlist event');
    }
  }

  /**
   * Returns true if the subscriber is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
