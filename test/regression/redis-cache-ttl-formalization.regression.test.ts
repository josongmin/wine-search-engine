/**
 * Regression: infra.redis-cache-layer maturity 3 → 4.
 *
 * Formalises per-cache TTL contract and adds a `sets` telemetry counter to
 * each cache's `getStats()` surface. Behaviour locked in:
 *
 * 1. `CACHE_TTL_SECONDS` exposes documented defaults (EMBEDDING/PHRASE/QUERY).
 * 2. Each cache's `set()` uses the documented default TTL when caller omits it.
 * 3. Each cache's `set()` still honours an explicit TTL (backward compatible).
 * 4. Each cache's `set()` increments a `sets` counter in Redis.
 * 5. `getStats()` exposes `{hits, misses, sets}` per the new telemetry hook.
 * 6. Korean cache keys (`'와인 추천'`) round-trip through set+get without mutation.
 *
 * Mocks Redis at the client port. NO real Redis required.
 */

import { describe, it, expect, vi } from 'vitest';
import { RedisEmbeddingCache } from '../../src/infrastructure/cache/redis-embedding-cache.js';
import { RedisPhraseCache } from '../../src/infrastructure/cache/redis-phrase-cache.js';
import { RedisQueryCache } from '../../src/infrastructure/cache/redis-query-cache.js';
import {
  CACHE_TTL_SECONDS,
  defaultTtlSecondsFor,
} from '../../src/infrastructure/cache/cache-ttl-config.js';
import type { RedisClient } from '../../src/infrastructure/db/redis-client.js';
import type { EmbeddingCacheKey, QueryCacheKey } from '../../src/domain/performance/model/cache-key.js';
import type { LlmConstraintItem } from '../../src/domain/attribute/model/llm-constraint-schema.js';

// ── In-memory Redis mock ────────────────────────────────────────────────

interface SetCall {
  readonly key: string;
  readonly value: string;
  readonly opts: { EX?: number } | undefined;
}

interface MockRedis {
  readonly client: RedisClient;
  readonly store: Map<string, string>;
  readonly setCalls: SetCall[];
  readonly incrKeys: string[];
  readonly counters: Map<string, number>;
}

function makeMockRedis(initial?: ReadonlyMap<string, string>): MockRedis {
  const store = new Map<string, string>(initial ?? []);
  const setCalls: SetCall[] = [];
  const incrKeys: string[] = [];
  const counters = new Map<string, number>();

  const client = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, options?: { EX?: number }) => {
      setCalls.push({ key, value, opts: options });
      store.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      incrKeys.push(key);
      // Also reflect into the kv store so getStats() can read counters back
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      store.set(key, String(next));
      return next;
    }),
    del: vi.fn(async (key: string) => {
      const had = store.delete(key);
      return had ? 1 : 0;
    }),
    info: vi.fn(async (_section: string) => 'used_memory:0\r\n'),
    strLen: vi.fn(async (key: string) => store.get(key)?.length ?? 0),
    scanIterator: vi.fn((_opts: { MATCH: string; COUNT: number }) => {
      // empty async iterator — entriesCount stays 0; not under test here.
      return (async function* () {
        // yield nothing
      })();
    }),
  } as unknown as RedisClient;

  return { client, store, setCalls, incrKeys, counters };
}

// ── Fixtures ────────────────────────────────────────────────────────────

const validConstraintItem: LlmConstraintItem = {
  phrase: 'fruity',
  attribute: 'flavor_profile',
  operator: 'in',
  value: 'fruity',
  confidence: 0.9,
};

const embeddingKey: EmbeddingCacheKey = {
  redisKey: 'embedding:text-embedding-3-small:abc123',
} as EmbeddingCacheKey;

const queryKey: QueryCacheKey = {
  redisKey: 'query:plan-abc:req-def',
} as QueryCacheKey;

const minimalSearchResponse = {
  engineDecision: { engine: 'hybrid' },
  results: [],
  meta: { snapshot_id: 'test' },
} as unknown as Parameters<RedisQueryCache['set']>[1];

// ── Tests ───────────────────────────────────────────────────────────────

describe('redis cache TTL formalization (E1: infra.redis-cache-layer 3→4)', () => {
  describe('CACHE_TTL_SECONDS constants', () => {
    it('EMBEDDING default = 7 days (604800s)', () => {
      expect(CACHE_TTL_SECONDS.EMBEDDING).toBe(7 * 24 * 60 * 60);
    });

    it('PHRASE default = 1 day (86400s)', () => {
      expect(CACHE_TTL_SECONDS.PHRASE).toBe(24 * 60 * 60);
    });

    it('QUERY default = 5 minutes (300s)', () => {
      expect(CACHE_TTL_SECONDS.QUERY).toBe(300);
    });

    it('defaultTtlSecondsFor() returns documented value per kind', () => {
      expect(defaultTtlSecondsFor('EMBEDDING')).toBe(CACHE_TTL_SECONDS.EMBEDDING);
      expect(defaultTtlSecondsFor('PHRASE')).toBe(CACHE_TTL_SECONDS.PHRASE);
      expect(defaultTtlSecondsFor('QUERY')).toBe(CACHE_TTL_SECONDS.QUERY);
    });
  });

  describe('RedisEmbeddingCache', () => {
    it('set() without TTL uses CACHE_TTL_SECONDS.EMBEDDING', async () => {
      const mock = makeMockRedis();
      const cache = new RedisEmbeddingCache(mock.client);

      await cache.set(embeddingKey, [0.1, 0.2, 0.3]);

      expect(mock.setCalls).toHaveLength(1);
      expect(mock.setCalls[0]?.opts).toEqual({ EX: CACHE_TTL_SECONDS.EMBEDDING });
    });

    it('set() honours explicit TTL (backward-compatible)', async () => {
      const mock = makeMockRedis();
      const cache = new RedisEmbeddingCache(mock.client);

      await cache.set(embeddingKey, [0.1, 0.2, 0.3], 60);

      expect(mock.setCalls[0]?.opts).toEqual({ EX: 60 });
    });

    it('set() increments sets counter', async () => {
      const mock = makeMockRedis();
      const cache = new RedisEmbeddingCache(mock.client);

      await cache.set(embeddingKey, [0.1, 0.2, 0.3]);
      // Counter is fire-and-forget; flush microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(mock.incrKeys).toContain('cache:stats:embedding:sets');
    });

    it('fresh instance reports zero sets via getStats()', async () => {
      const mock = makeMockRedis();
      const cache = new RedisEmbeddingCache(mock.client);

      const stats = await cache.getStats();

      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.sets).toBe(0);
    });

    it('after 1 set + 2 gets (hit then miss): stats = {hits:1, misses:1, sets:1}', async () => {
      const mock = makeMockRedis();
      const cache = new RedisEmbeddingCache(mock.client);

      await cache.set(embeddingKey, [0.1, 0.2, 0.3]);
      await cache.get(embeddingKey); // hit
      await cache.get({ redisKey: 'embedding:absent:xyz' } as EmbeddingCacheKey); // miss
      await Promise.resolve();
      await Promise.resolve();

      const stats = await cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.sets).toBe(1);
    });
  });

  describe('RedisPhraseCache', () => {
    it('set() without TTL uses CACHE_TTL_SECONDS.PHRASE', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      await cache.set('test', [validConstraintItem]);

      expect(mock.setCalls[0]?.opts).toEqual({ EX: CACHE_TTL_SECONDS.PHRASE });
    });

    it('set() honours explicit TTL (backward-compatible)', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      await cache.set('test', [validConstraintItem], 3600);

      expect(mock.setCalls[0]?.opts).toEqual({ EX: 3600 });
    });

    it('set() increments sets counter', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      await cache.set('test', [validConstraintItem]);
      await Promise.resolve();
      await Promise.resolve();

      expect(mock.incrKeys).toContain('cache:stats:phrase:sets');
    });

    it('getStats() includes sets counter (fresh = 0)', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);

      const stats = await cache.getStats();

      expect(stats).toEqual({ hits: 0, misses: 0, sets: 0 });
    });

    it('Korean cache key round-trip stable (NFC preserved through set+get)', async () => {
      const mock = makeMockRedis();
      const cache = new RedisPhraseCache(mock.client);
      const koreanPhrase = '와인 추천';

      await cache.set(koreanPhrase, [validConstraintItem]);
      const result = await cache.get(koreanPhrase);

      expect(result).toEqual([validConstraintItem]);
      // Verify the Redis key prefix was applied with Korean intact
      expect(mock.setCalls[0]?.key).toBe(`phrase:${koreanPhrase}`);
      expect(mock.setCalls[0]?.key.normalize('NFC')).toBe(mock.setCalls[0]?.key);
    });
  });

  describe('RedisQueryCache', () => {
    it('set() without TTL uses CACHE_TTL_SECONDS.QUERY', async () => {
      const mock = makeMockRedis();
      const cache = new RedisQueryCache(mock.client);

      await cache.set(queryKey, minimalSearchResponse);

      expect(mock.setCalls).toHaveLength(1);
      expect(mock.setCalls[0]?.opts).toEqual({ EX: CACHE_TTL_SECONDS.QUERY });
    });

    it('set() honours explicit TTL (backward-compatible)', async () => {
      const mock = makeMockRedis();
      const cache = new RedisQueryCache(mock.client);

      await cache.set(queryKey, minimalSearchResponse, 30);

      expect(mock.setCalls[0]?.opts).toEqual({ EX: 30 });
    });

    it('set() increments sets counter', async () => {
      const mock = makeMockRedis();
      const cache = new RedisQueryCache(mock.client);

      await cache.set(queryKey, minimalSearchResponse);
      await Promise.resolve();
      await Promise.resolve();

      expect(mock.incrKeys).toContain('cache:stats:query:sets');
    });

    it('getStats() includes sets counter', async () => {
      const mock = makeMockRedis();
      const cache = new RedisQueryCache(mock.client);

      const stats = await cache.getStats();

      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.sets).toBe(0);
    });
  });
});
