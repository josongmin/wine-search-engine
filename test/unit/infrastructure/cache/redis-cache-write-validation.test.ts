/**
 * E5-T11: BUG-DS07 — Redis cache write-time Zod validation
 * Verifies that invalid shapes are not written and valid shapes are written.
 */
import { describe, it, expect, vi } from 'vitest';
import { RedisCache } from '../../../../src/infrastructure/adapter/redis-cache.js';
import type { RedisClient } from '../../../../src/infrastructure/db/redis-client.js';

function makeRedisClient(setFn = vi.fn()): RedisClient {
  return {
    get: vi.fn(),
    set: setFn,
    del: vi.fn(),
    incr: vi.fn(),
    ping: vi.fn(),
  } as unknown as RedisClient;
}

import { z } from 'zod';

const TestSchema = z.object({ id: z.string(), value: z.number().finite() }).strict();

describe('E5-T11: RedisCache.setValidated write-time validation', () => {
  it('does NOT call redis.set when shape is invalid', async () => {
    const setFn = vi.fn();
    const client = makeRedisClient(setFn);
    const cache = new RedisCache(client, 60);

    const invalid = { id: 'test', value: NaN };
    const written = await cache.setValidated('key:1', invalid, TestSchema, 'TestComponent', 60);

    expect(written).toBe(false);
    expect(setFn).not.toHaveBeenCalled();
  });

  it('DOES call redis.set when shape is valid', async () => {
    const setFn = vi.fn().mockResolvedValue('OK');
    const client = makeRedisClient(setFn);
    const cache = new RedisCache(client, 60);

    const valid = { id: 'wine-1', value: 42 };
    const written = await cache.setValidated('key:2', valid, TestSchema, 'TestComponent', 60);

    expect(written).toBe(true);
    expect(setFn).toHaveBeenCalledOnce();
    expect(setFn).toHaveBeenCalledWith('key:2', JSON.stringify(valid), { EX: 60 });
  });

  it('rejects shape with extra fields (strict schema)', async () => {
    const setFn = vi.fn();
    const client = makeRedisClient(setFn);
    const cache = new RedisCache(client, 60);

    const withExtra = { id: 'wine-1', value: 1, extra: 'field' };
    const written = await cache.setValidated('key:3', withExtra, TestSchema, 'TestComponent', 60);

    expect(written).toBe(false);
    expect(setFn).not.toHaveBeenCalled();
  });
});
