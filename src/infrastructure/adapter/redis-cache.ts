import { deleteRedisKeysMatchingPattern } from '../db/redis-delete-by-pattern.js';
import type { RedisClient } from '../db/redis-client.js';

export class RedisCache {
  constructor(
    private readonly client: RedisClient,
    private readonly defaultTtlSeconds: number,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.defaultTtlSeconds;
    const serialized = JSON.stringify(value);
    await this.client.set(key, serialized, { EX: ttl });
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async invalidatePattern(pattern: string): Promise<void> {
    await deleteRedisKeysMatchingPattern(this.client, pattern);
  }
}
