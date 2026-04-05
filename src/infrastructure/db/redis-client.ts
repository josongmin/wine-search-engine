import { createClient } from 'redis';
import { config } from '../../config/env.js';

/** Connected client instance from {@link createClient} (generic-safe for exactOptionalPropertyTypes). */
export type RedisClient = ReturnType<typeof createClient>;
export type RedisConfig = typeof config.redis;

let client: RedisClient | null = null;

export async function connectRedisClient(redisConfig: RedisConfig): Promise<RedisClient> {
  const nextClient = createClient({ url: redisConfig.url });
  nextClient.on('error', (err: Error) => {
    console.error('Redis Client Error', err);
  });
  await nextClient.connect();
  client = nextClient;
  return nextClient;
}

/**
 * Returns a connected Redis client (node-redis). Safe to call multiple times.
 */
export async function getRedisClient(redisConfig: RedisConfig = config.redis): Promise<RedisClient> {
  if (!client) {
    return connectRedisClient(redisConfig);
  }
  return client;
}

export async function closeRedisClient(redisClient: RedisClient | null = client): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.quit();
  }
  if (redisClient === client) {
    client = null;
  }
}

export function peekRedisClient(): RedisClient | null {
  return client;
}
