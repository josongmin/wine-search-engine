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
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;
/** Maximum Redis pub/sub message size (bytes). Prevents memory exhaustion on
 *  subscriber side when large event payloads are published inadvertently.
 *  Redis has no hard cap, but node-redis buffers the full message in process
 *  memory before dispatching; 10 MB covers any realistic watchlist event. */
const REDIS_PUBLISH_MAX_BYTES = 10 * BYTES_PER_MB; // 10 MB

const redisPublisherLog = bootstrapLogger.child({ component: 'RedisWatchlistPublisher' });

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

    // Guard: reject oversized messages before publish to prevent subscriber-side
    // memory exhaustion. Buffer.byteLength gives the UTF-8 byte count, which may
    // exceed payload.length for multi-byte Unicode characters in event data.
    const byteLength = Buffer.byteLength(payload, 'utf8');
    if (byteLength > REDIS_PUBLISH_MAX_BYTES) {
      redisPublisherLog.error(
        { entityId, channel, byteLength, maxBytes: REDIS_PUBLISH_MAX_BYTES },
        'watchlist publish rejected: payload exceeds size limit',
      );
      throw new Error(
        `WatchlistPublisher: payload too large (${String(byteLength)} bytes, max ${String(REDIS_PUBLISH_MAX_BYTES)})`,
      );
    }

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
