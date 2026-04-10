import { describe, it, expect, vi } from 'vitest';
import { RedisPhraseCache } from '../redis-phrase-cache.js';
import type { LlmConstraintItem } from '../../../domain/attribute/model/llm-constraint-schema.js';
import type { RedisClient } from '../../db/redis-client.js';
import { MS_PER_DAY } from '../../../domain/shared/utils/time-units.js';

// ── Helpers ────────────────────────────────────────────────────────────

interface MockRedisOptions {
  readonly initial?: ReadonlyMap<string, string>;
  readonly getError?: Error;
  readonly setError?: Error;
  readonly incrError?: Error;
}

interface MockRedis {
  readonly client: RedisClient;
  readonly store: Map<string, string>;
  readonly setCalls: Array<{ key: string; value: string; opts: { EX?: number } | undefined }>;
  readonly incrKeys: string[];
}

function makeMockRedis(opts: MockRedisOptions = {}): MockRedis {
  const store = new Map<string, string>(opts.initial ?? []);
  const setCalls: MockRedis['setCalls'] = [];
  const incrKeys: string[] = [];
  const counters = new Map<string, number>();

  const client = {
    get: vi.fn(async (key: string) => {
      if (opts.getError) throw opts.getError;
      return store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string, options?: { EX?: number }) => {
      if (opts.setError) throw opts.setError;
      setCalls.push({ key, value, opts: options });
      store.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      if (opts.incrError) throw opts.incrError;
      incrKeys.push(key);
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
  } as unknown as RedisClient;

  return { client, store, setCalls, incrKeys };
}

const validItem: LlmConstraintItem = {
  phrase: 'test_phrase',
  attribute: 'flavor_profile',
  operator: 'in',
  value: 'fruity',
  confidence: 0.85,
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('RedisPhraseCache', () => {
  describe('get', () => {
    it('returns parsed items on hit and increments hit counter', async () => {
      const mock = makeMockRedis({
        initial: new Map([['phrase:test', JSON.stringify([validItem])]]),
      });
      const cache = new RedisPhraseCache(mock.client);

      const result = await cache.get('test');

      expect(result).toEqual([validItem]);
      // Async fire-and-forget; let microtasks settle
      await Promise.resolve();
      expect(mock.incrKeys).toContain('cache:stats:phrase:hits');
    });

    it('returns null on miss and increments miss counter', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      const result = await cache.get('absent');

      expect(result).toBeNull();
      await Promise.resolve();
      expect(mock.incrKeys).toContain('cache:stats:phrase:misses');
    });

    it('returns empty array (negative cache entry) intact', async () => {
      const mock = makeMockRedis({
        initial: new Map([['phrase:nomatch', JSON.stringify([])]]),
      });
      const cache = new RedisPhraseCache(mock.client);

      const result = await cache.get('nomatch');

      expect(result).toEqual([]);
    });

    it('schema-drift entry → treats as miss, does NOT increment hits', async () => {
      const mock = makeMockRedis({
        initial: new Map([
          ['phrase:bad', JSON.stringify([{ phrase: 'bad', attribute: 'x' /* missing fields */ }])],
        ]),
      });
      const cache = new RedisPhraseCache(mock.client);

      const result = await cache.get('bad');

      expect(result).toBeNull();
      await Promise.resolve();
      expect(mock.incrKeys).toContain('cache:stats:phrase:misses');
      expect(mock.incrKeys).not.toContain('cache:stats:phrase:hits');
    });

    it('redis throwing → swallowed, returns null, increments miss', async () => {
      const mock = makeMockRedis({ getError: new Error('redis down') });
      const cache = new RedisPhraseCache(mock.client);

      const result = await cache.get('test');

      expect(result).toBeNull();
      await Promise.resolve();
      expect(mock.incrKeys).toContain('cache:stats:phrase:misses');
    });

    it('malformed JSON → caught, returns null without throwing', async () => {
      const mock = makeMockRedis({
        initial: new Map([['phrase:broken', 'not-valid-json']]),
      });
      const cache = new RedisPhraseCache(mock.client);

      await expect(cache.get('broken')).resolves.toBeNull();
    });
  });

  describe('set', () => {
    it('writes JSON-serialized items with EX TTL', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      await cache.set('test', [validItem], 3_600);

      expect(mock.setCalls).toHaveLength(1);
      expect(mock.setCalls[0]?.key).toBe('phrase:test');
      expect(mock.setCalls[0]?.opts).toEqual({ EX: 3_600 });
      expect(JSON.parse(mock.setCalls[0]!.value)).toEqual([validItem]);
    });

    it('clamps TTL=0 to MIN (1) — Redis would otherwise reject', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      await cache.set('test', [validItem], 0);

      expect(mock.setCalls[0]?.opts).toEqual({ EX: 1 });
    });

    it('clamps negative TTL to MIN', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      await cache.set('test', [validItem], -100);

      expect(mock.setCalls[0]?.opts).toEqual({ EX: 1 });
    });

    it('clamps TTL larger than 7d to 7d', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);
      const sevenDays = (7 * MS_PER_DAY) / 1000;

      await cache.set('test', [validItem], sevenDays * 10);

      expect(mock.setCalls[0]?.opts).toEqual({ EX: sevenDays });
    });

    it('writes empty array (negative cache) without throwing', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      await cache.set('nomatch', [], 600);

      expect(mock.setCalls[0]?.value).toBe('[]');
    });

    it('redis throwing on set → swallowed silently', async () => {
      const mock = makeMockRedis({ setError: new Error('redis write fail') });
      const cache = new RedisPhraseCache(mock.client);

      await expect(cache.set('test', [validItem], 60)).resolves.toBeUndefined();
    });

    it('non-finite TTL → clamped to MIN', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      await cache.set('test', [validItem], Number.NaN);

      expect(mock.setCalls[0]?.opts).toEqual({ EX: 1 });
    });
  });

  describe('getStats', () => {
    it('returns parsed counters from Redis', async () => {
      const mock = makeMockRedis({
        initial: new Map([
          ['cache:stats:phrase:hits', '42'],
          ['cache:stats:phrase:misses', '17'],
        ]),
      });
      const cache = new RedisPhraseCache(mock.client);

      const stats = await cache.getStats();

      expect(stats).toEqual({ hits: 42, misses: 17 });
    });

    it('returns zeros when counters are absent', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      const stats = await cache.getStats();

      expect(stats).toEqual({ hits: 0, misses: 0 });
    });

    it('returns zeros on Redis error', async () => {
      const mock = makeMockRedis({ getError: new Error('boom') });
      const cache = new RedisPhraseCache(mock.client);

      const stats = await cache.getStats();

      expect(stats).toEqual({ hits: 0, misses: 0 });
    });
  });
});
