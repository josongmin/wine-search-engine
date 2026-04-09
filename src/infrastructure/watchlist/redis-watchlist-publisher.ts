/**
 * Epic 17.1: Redis Watchlist Publisher
 *
 * Publishes entity change events to Redis channels for async processing.
 * Uses the shared Redis client from redis-client.ts.
 */

import {
  getRedisClient,
  type RedisClient,
  type RedisConfig,
} from '../db/redis-client.js';
import type { WatchlistChangeEvent } from '../../domain/watchlist/model/watchlist-entry.js';

export interface WatchlistPublisherPort {
  publishUpdate(entityId: string, event: WatchlistChangeEvent): Promise<void>;
}

interface RedisWatchlistPublisherOptions {
  readonly client?: RedisClient;
  readonly redisConfig?: RedisConfig;
}

/**
 * Publishes watchlist change events to Redis pub/sub.
 * Events are published to channel "watchlist:{entityId}" for routing to subscribers.
 */
export class RedisWatchlistPublisher implements WatchlistPublisherPort {
  private client: RedisClient | null = null;
  private readonly redisConfig: RedisConfig | undefined;

  constructor(options?: RedisWatchlistPublisherOptions) {
    this.client = options?.client ?? null;
    this.redisConfig = options?.redisConfig;
  }

  /**
   * Publishes an entity change event to a watchlist channel.
   *
   * @param entityId - The entity that changed.
   * @param event - The change event details.
   * @throws On Redis connection failure.
   */
  async publishUpdate(entityId: string, event: WatchlistChangeEvent): Promise<void> {
    const client = await this.ensureClient();
    const channel = `watchlist:${entityId}`;
    const payload = JSON.stringify(event);

    // Publish to the channel; subscribers will be notified
    await client.publish(channel, payload);
  }

  /**
   * Ensures a connected Redis client is available (lazy initialization).
   */
  private async ensureClient(): Promise<RedisClient> {
    this.client ??= await getRedisClient(this.redisConfig);
    return this.client;
  }
}
