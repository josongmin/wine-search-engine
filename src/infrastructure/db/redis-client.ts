import { createClient } from 'redis';
import { config } from '../../config/env.js';

/** Connected client instance from {@link createClient} (generic-safe for exactOptionalPropertyTypes). */
export type RedisClient = ReturnType<typeof createClient>;

let client: RedisClient | null = null;

/**
 * Returns a connected Redis client (node-redis). Safe to call multiple times.
 */
export async function getRedisClient(): Promise<RedisClient> {
  if (!client) {
    const c = createClient({ url: config.redis.url });
    c.on('error', (err: Error) => {
      console.error('Redis Client Error', err);
    });
    await c.connect();
    client = c;
  }
  return client;
}

export async function closeRedisClient(): Promise<void> {
  if (client?.isOpen) {
    await client.quit();
  }
  client = null;
}
