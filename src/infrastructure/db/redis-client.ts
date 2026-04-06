import { createClient } from 'redis';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';
import { config } from '../../config/env.js';

/** Connected client instance from {@link createClient} (generic-safe for exactOptionalPropertyTypes). */
export type RedisClient = ReturnType<typeof createClient>;
export type RedisConfig = typeof config.redis;

let client: RedisClient | null = null;
/** Serializes concurrent first connects; always uses the first caller's {@link redisConfig}. */
let connectPromise: Promise<RedisClient> | null = null;

export async function connectRedisClient(redisConfig: RedisConfig): Promise<RedisClient> {
  const nextClient = createClient({ url: redisConfig.url });
  nextClient.on('error', (err: Error) => {
    bootstrapLogger.error({ err }, 'Redis client error');
  });
  await nextClient.connect();
  client = nextClient;
  return nextClient;
}

/**
 * Returns a connected Redis client (node-redis). Safe to call multiple times.
 * Concurrent cold starts share one in-flight connection attempt.
 */
export async function getRedisClient(redisConfig: RedisConfig = config.redis): Promise<RedisClient> {
  if (client) {
    return client;
  }
  if (!connectPromise) {
    connectPromise = connectRedisClient(redisConfig).finally(() => {
      connectPromise = null;
    });
  }
  return connectPromise;
}

export async function closeRedisClient(redisClient: RedisClient | null = client): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit();
  }
  if (redisClient === client) {
    client = null;
    connectPromise = null;
  }
}

export function peekRedisClient(): RedisClient | null {
  return client;
}
