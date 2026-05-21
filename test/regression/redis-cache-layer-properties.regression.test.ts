/**
 * Regression: infra.redis-cache-layer maturity 4 → 5 (SOTA++).
 *
 * Property-based formalisation (fast-check, numRuns:100) of the cache-layer
 * invariants that Wave 1 (3→4) locked in by example. Where the TTL-formalization
 * suite asserts specific values, this suite asserts the *laws* those values must
 * obey for arbitrary inputs:
 *
 * 1. **TTL ordering + positivity** — EMBEDDING ≥ PHRASE ≥ QUERY, all > 0.
 *    (Stability ordering: the more stable the cached artifact, the longer it lives.)
 * 2. **Cache-key determinism** — for the embedding and query key builders, equal
 *    inputs always produce the identical `redisKey` (content-addressable).
 * 3. **Hit/miss/set stats accuracy** — after an arbitrary op sequence, `getStats()`
 *    reports counts that exactly match the issued operations.
 * 4. **Korean key NFC stability** — a Korean phrase key passes through set+get
 *    unmutated, and the stored key is NFC-stable.
 * 5. **SET uses the correct per-cache default TTL** — every default `set()` issues
 *    a Redis SET with `EX` equal to that cache's `CACHE_TTL_SECONDS` value.
 * 6. **Miss returns null/undefined gracefully** — absent keys never throw.
 * 7. **Round-trip** — set then get returns the stored value (in-memory mock).
 *
 * Mocks Redis at the client port. NO real Redis required.
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { RedisEmbeddingCache } from '../../src/infrastructure/cache/redis-embedding-cache.js';
import { RedisPhraseCache } from '../../src/infrastructure/cache/redis-phrase-cache.js';
import { RedisQueryCache } from '../../src/infrastructure/cache/redis-query-cache.js';
import { CACHE_TTL_SECONDS } from '../../src/infrastructure/cache/cache-ttl-config.js';
import {
  EmbeddingCacheKeyBuilder,
  QueryCacheKeyBuilder,
} from '../../src/domain/performance/model/cache-key.js';
import { RETRIEVAL_MODES } from '../../src/domain/query/model/retrieval-mode.js';
import type { RetrievalMode } from '../../src/domain/query/model/retrieval-mode.js';
import type { RedisClient } from '../../src/infrastructure/db/redis-client.js';
import type {
  EmbeddingCacheKey,
  QueryCacheKey,
} from '../../src/domain/performance/model/cache-key.js';
import type { LlmConstraintItem } from '../../src/domain/attribute/model/llm-constraint-schema.js';

const NUM_RUNS = 100;

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
}

function makeMockRedis(): MockRedis {
  const store = new Map<string, string>();
  const setCalls: SetCall[] = [];
  const incrKeys: string[] = [];

  const client = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, options?: { EX?: number }) => {
      setCalls.push({ key, value, opts: options });
      store.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      incrKeys.push(key);
      const next = Number.parseInt(store.get(key) ?? '0', 10) + 1;
      store.set(key, String(next));
      return next;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    info: vi.fn(async (_section: string) => 'used_memory:0\r\n'),
    strLen: vi.fn(async (key: string) => store.get(key)?.length ?? 0),
    scanIterator: vi.fn((_opts: { MATCH: string; COUNT: number }) =>
      (async function* () {
        /* empty iterator — entriesCount not under test here */
      })(),
    ),
  } as unknown as RedisClient;

  return { client, store, setCalls, incrKeys };
}

/** Flush fire-and-forget counter increments (set() increments are not awaited). */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ── Fixtures / arbitraries ──────────────────────────────────────────────

const validConstraintItem: LlmConstraintItem = {
  phrase: 'fruity',
  attribute: 'flavor_profile',
  operator: 'in',
  value: 'fruity',
  confidence: 0.9,
};

/**
 * Embedding vector: non-empty array of finite numbers (matches EmbeddingVectorSchema).
 *
 * `-0` is mapped to `0` because the cache round-trips through JSON, and
 * `JSON.stringify(-0)` emits `"0"`. The cache contract is numeric value-equality,
 * not IEEE-754 bit-identity, so collapsing signed zero keeps the arbitrary aligned
 * with the documented serialization behavior rather than testing a non-contract.
 */
const arbEmbedding = fc.array(
  fc
    .float({ noNaN: true, noDefaultInfinity: true, min: -1, max: 1 })
    .map((n) => (Object.is(n, -0) ? 0 : n)),
  { minLength: 1, maxLength: 32 },
);

const arbRetrievalMode: fc.Arbitrary<RetrievalMode> = fc.constantFrom(
  ...RETRIEVAL_MODES,
);

// Korean syllables for NFC/NFD stability probing.
const arbKorean = fc.stringMatching(/^[가-힣]{1,8}$/u);

// ── Tests ───────────────────────────────────────────────────────────────

describe('redis cache layer properties (E1: infra.redis-cache-layer 4→5)', () => {
  // Property 1: TTL ordering + positivity
  describe('TTL contract invariants', () => {
    it('all TTL constants are positive integers', () => {
      for (const kind of ['EMBEDDING', 'PHRASE', 'QUERY'] as const) {
        const ttl = CACHE_TTL_SECONDS[kind];
        expect(Number.isInteger(ttl)).toBe(true);
        expect(ttl).toBeGreaterThan(0);
      }
    });

    it('TTL ordering EMBEDDING ≥ PHRASE ≥ QUERY (stability ordering)', () => {
      expect(CACHE_TTL_SECONDS.EMBEDDING).toBeGreaterThanOrEqual(CACHE_TTL_SECONDS.PHRASE);
      expect(CACHE_TTL_SECONDS.PHRASE).toBeGreaterThanOrEqual(CACHE_TTL_SECONDS.QUERY);
    });
  });

  // Property 2: cache-key determinism (content-addressable)
  describe('cache key determinism', () => {
    it('EmbeddingCacheKeyBuilder: equal inputs → identical redisKey', () => {
      const builder = new EmbeddingCacheKeyBuilder();
      fc.assert(
        fc.property(
          fc.string(),
          fc.string({ minLength: 1 }),
          fc.option(fc.string(), { nil: undefined }),
          (text, modelId, prefix) => {
            const a = builder.build(text, modelId, prefix);
            const b = builder.build(text, modelId, prefix);
            expect(a.redisKey).toBe(b.redisKey);
            // Content-addressable: key encodes only deterministic inputs.
            expect(a.redisKey.startsWith(`embedding:${modelId}:`)).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('QueryCacheKeyBuilder: equal inputs → identical redisKey', () => {
      const builder = new QueryCacheKeyBuilder();
      fc.assert(
        fc.property(
          fc.string(),
          arbRetrievalMode,
          fc.array(
            fc.tuple(fc.string(), fc.string(), fc.string()),
            { maxLength: 6 },
          ),
          fc.array(fc.string(), { maxLength: 6 }),
          (query, mode, tuples, expansions) => {
            const a = builder.build(query, mode, tuples, expansions);
            const b = builder.build(query, mode, tuples, expansions);
            expect(a.redisKey).toBe(b.redisKey);
            expect(a.redisKey.startsWith('query:')).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('QueryCacheKeyBuilder: constraint order does not affect key (sorted)', () => {
      const builder = new QueryCacheKeyBuilder();
      fc.assert(
        fc.property(
          fc.string(),
          arbRetrievalMode,
          fc.array(fc.tuple(fc.string(), fc.string(), fc.string()), {
            minLength: 2,
            maxLength: 6,
          }),
          (query, mode, tuples) => {
            const reversed = [...tuples].reverse();
            const a = builder.build(query, mode, tuples, []);
            const b = builder.build(query, mode, reversed, []);
            expect(a.redisKey).toBe(b.redisKey);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // Property 3: hit/miss/set stats accuracy
  describe('stats accuracy after arbitrary op sequence', () => {
    it('embedding cache: getStats() exactly reflects sets + hits + misses', async () => {
      await fc.assert(
        fc.asyncProperty(
          // ops: true = set+hit, false = miss on a fresh absent key
          fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
          async (ops) => {
            const mock = makeMockRedis();
            const cache = new RedisEmbeddingCache(mock.client);
            let expectedSets = 0;
            let expectedHits = 0;
            let expectedMisses = 0;

            for (let i = 0; i < ops.length; i++) {
              const key = { redisKey: `embedding:m:k${i}` } as EmbeddingCacheKey;
              if (ops[i] === true) {
                await cache.set(key, [0.1, 0.2]);
                expectedSets++;
                await cache.get(key); // hit
                expectedHits++;
              } else {
                await cache.get(key); // absent → miss
                expectedMisses++;
              }
            }
            await flushMicrotasks();

            const stats = await cache.getStats();
            expect(stats.sets).toBe(expectedSets);
            expect(stats.hits).toBe(expectedHits);
            expect(stats.misses).toBe(expectedMisses);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('query cache: getStats() exactly reflects sets + hits + misses', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }),
          async (ops) => {
            const mock = makeMockRedis();
            const cache = new RedisQueryCache(mock.client);
            const response = {
              engineDecision: { engine: 'hybrid' },
              results: [],
              meta: { snapshot_id: 'p' },
            } as unknown as Parameters<RedisQueryCache['set']>[1];
            let expectedSets = 0;
            let expectedHits = 0;
            let expectedMisses = 0;

            for (let i = 0; i < ops.length; i++) {
              const key = { redisKey: `query:p:k${i}` } as QueryCacheKey;
              if (ops[i] === true) {
                await cache.set(key, response);
                expectedSets++;
                await cache.get(key); // hit
                expectedHits++;
              } else {
                await cache.get(key); // miss
                expectedMisses++;
              }
            }
            await flushMicrotasks();

            const stats = await cache.getStats();
            expect(stats.sets).toBe(expectedSets);
            expect(stats.hits).toBe(expectedHits);
            expect(stats.misses).toBe(expectedMisses);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // Property 4: Korean key NFC stability
  describe('Korean key NFC stability', () => {
    it('phrase cache: Korean keys round-trip; stored NFC key is stable', async () => {
      await fc.assert(
        fc.asyncProperty(arbKorean, async (korean) => {
          const mock = makeMockRedis();
          const cache = new RedisPhraseCache(mock.client);
          const nfc = korean.normalize('NFC');

          await cache.set(nfc, [validConstraintItem]);
          const got = await cache.get(nfc);

          expect(got).toEqual([validConstraintItem]);
          const storedKey = mock.setCalls[0]?.key;
          expect(storedKey).toBe(`phrase:${nfc}`);
          // The stored key must be NFC-stable (normalize is idempotent on NFC).
          expect(storedKey?.normalize('NFC')).toBe(storedKey);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('embedding key builder: Korean text is NFC-stable in the hashed key (deterministic)', () => {
      const builder = new EmbeddingCacheKeyBuilder();
      fc.assert(
        fc.property(arbKorean, (korean) => {
          const nfc = korean.normalize('NFC');
          // Same NFC text → same key on repeat (content-addressable).
          expect(builder.build(nfc, 'm').redisKey).toBe(builder.build(nfc, 'm').redisKey);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // Property 5: SET uses correct per-cache default TTL
  describe('default SET uses correct per-cache TTL', () => {
    it('embedding set() without TTL → EX = CACHE_TTL_SECONDS.EMBEDDING', async () => {
      await fc.assert(
        fc.asyncProperty(arbEmbedding, async (vec) => {
          const mock = makeMockRedis();
          const cache = new RedisEmbeddingCache(mock.client);
          await cache.set({ redisKey: 'embedding:m:k' } as EmbeddingCacheKey, vec);
          expect(mock.setCalls[0]?.opts).toEqual({ EX: CACHE_TTL_SECONDS.EMBEDDING });
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('phrase set() without TTL → EX = CACHE_TTL_SECONDS.PHRASE', async () => {
      await fc.assert(
        fc.asyncProperty(arbKorean, async (korean) => {
          const mock = makeMockRedis();
          const cache = new RedisPhraseCache(mock.client);
          await cache.set(korean.normalize('NFC'), [validConstraintItem]);
          expect(mock.setCalls[0]?.opts).toEqual({ EX: CACHE_TTL_SECONDS.PHRASE });
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('query set() without TTL → EX = CACHE_TTL_SECONDS.QUERY', async () => {
      const mock = makeMockRedis();
      const cache = new RedisQueryCache(mock.client);
      const response = {
        engineDecision: { engine: 'hybrid' },
        results: [],
        meta: { snapshot_id: 'p' },
      } as unknown as Parameters<RedisQueryCache['set']>[1];
      await cache.set({ redisKey: 'query:p:k' } as QueryCacheKey, response);
      expect(mock.setCalls[0]?.opts).toEqual({ EX: CACHE_TTL_SECONDS.QUERY });
    });
  });

  // Property 6: miss returns null/undefined gracefully (never throws)
  describe('absent key never throws', () => {
    it('embedding get() on absent key → undefined', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (suffix) => {
          const mock = makeMockRedis();
          const cache = new RedisEmbeddingCache(mock.client);
          const got = await cache.get({ redisKey: `embedding:absent:${suffix}` } as EmbeddingCacheKey);
          expect(got).toBeUndefined();
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('phrase get() on absent key → null', async () => {
      await fc.assert(
        fc.asyncProperty(arbKorean, async (korean) => {
          const mock = makeMockRedis();
          const cache = new RedisPhraseCache(mock.client);
          const got = await cache.get(korean.normalize('NFC'));
          expect(got).toBeNull();
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('query get() on absent key → undefined', async () => {
      await fc.assert(
        fc.asyncProperty(fc.string(), async (suffix) => {
          const mock = makeMockRedis();
          const cache = new RedisQueryCache(mock.client);
          const got = await cache.get({ redisKey: `query:absent:${suffix}` } as QueryCacheKey);
          expect(got).toBeUndefined();
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // Property 7: round-trip set → get returns stored value
  describe('round-trip set → get', () => {
    it('embedding cache: set then get returns the stored vector', async () => {
      await fc.assert(
        fc.asyncProperty(arbEmbedding, async (vec) => {
          const mock = makeMockRedis();
          const cache = new RedisEmbeddingCache(mock.client);
          const key = { redisKey: 'embedding:m:rt' } as EmbeddingCacheKey;
          await cache.set(key, vec);
          const got = await cache.get(key);
          expect(got).toEqual(vec);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('phrase cache: set then get returns the stored constraint items', async () => {
      await fc.assert(
        fc.asyncProperty(arbKorean, async (korean) => {
          const mock = makeMockRedis();
          const cache = new RedisPhraseCache(mock.client);
          const phrase = korean.normalize('NFC');
          await cache.set(phrase, [validConstraintItem]);
          const got = await cache.get(phrase);
          expect(got).toEqual([validConstraintItem]);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });
});
