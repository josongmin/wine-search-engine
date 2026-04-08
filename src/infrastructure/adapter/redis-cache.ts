import type { ZodType } from 'zod';
import { deleteRedisKeysMatchingPattern } from '../db/redis-delete-by-pattern.js';
import type { RedisClient } from '../db/redis-client.js';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'RedisCache' });

export class RedisCache {
  constructor(
    private readonly client: RedisClient,
    private readonly defaultTtlSeconds: number,
  ) {}

  /**
   * @deprecated Prefer {@link getValidated} which validates the parsed value
   * against a Zod schema. The unchecked generic cast on `get<T>` returns
   * silently-typed garbage when cache contents drift or are corrupted.
   */
  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw == null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed as T;
    } catch {
      return null;
    }
  }

  /**
   * Validated cache read. Returns null on miss, parse error, or shape mismatch.
   * Logs (without raising) when a cache entry has the wrong shape so operators
   * can detect schema drift / cache poisoning.
   */
  async getValidated<T>(key: string, schema: ZodType<T>): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw == null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      log.warn(
        { key, issues: result.error.issues.slice(0, 3) },
        'redis cache entry has unexpected shape; treating as miss',
      );
      // Best-effort: delete the poisoned entry so subsequent reads don't keep paying.
      void this.client.del(key).catch(() => undefined);
      return null;
    }
    return result.data;
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
