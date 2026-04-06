import type { RedisClient } from './redis-client.js';

const DEFAULT_SCAN_COUNT = 100;

/**
 * Deletes all keys matching a glob-style pattern using SCAN (not KEYS),
 * suitable for production clusters.
 */
export async function deleteRedisKeysMatchingPattern(
  redis: RedisClient,
  pattern: string,
  options?: { readonly scanCount?: number },
): Promise<number> {
  const scanCount = options?.scanCount ?? DEFAULT_SCAN_COUNT;
  let deleted = 0;
  for await (const key of redis.scanIterator({
    MATCH: pattern,
    COUNT: scanCount,
  })) {
    const keyStr = typeof key === 'string' ? key : String(key);
    await redis.del(keyStr);
    deleted++;
  }
  return deleted;
}
