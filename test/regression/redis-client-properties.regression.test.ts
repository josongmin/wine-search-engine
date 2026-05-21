/**
 * Property-based regression tests for the Redis cache layer.
 *
 * The Redis client is a non-authoritative cache in front of an authoritative
 * primary source (PostgreSQL / Vespa / compute). Its single most important
 * safety contract is **graceful degradation**: a cache miss, a circuit-breaker
 * open state, or a transient infra error must NEVER propagate as a thrown
 * exception into the hot retrieval path — every such condition must collapse to
 * a benign `null` (cache-miss semantics) so the caller falls back to the
 * primary source. See `tools/feature-catalog/features/infra/redis.yaml`.
 *
 * These properties exercise the `RedisCircuitBreakerWrapper` against a fully
 * mocked in-memory Redis (`RedisClientLike` / `scanIterator` seams) — NO real
 * Redis is contacted. The circuit breaker's recovery transition is wall-clock
 * driven (`Date.now()` inside `circuit-breaker.ts`), so `vi.useFakeTimers()`
 * acts as the injectable clock: advancing fake time past `recoveryTimeoutMs`
 * lets us observe the OPEN → HALF_OPEN probe transition deterministically.
 *
 * SOTA++ invariants (fast-check, numRuns: 100):
 *   P1. Cache miss → null fallback — for any key not present in the store,
 *       `get` resolves to `null` without throwing.
 *   P2. Breaker open → fallback without hitting Redis — when the breaker is
 *       OPEN, `get` returns `null` and the underlying client is never invoked.
 *   P3. get/set round-trip — `set(k, v)` then `get(k)` yields exactly `v`.
 *   P4. Korean key/value round-trip — Korean (한글) keys and values survive
 *       the round-trip byte-for-byte (no transliteration / truncation).
 *   P5. delete-by-pattern is bounded — a glob pattern delete removes ONLY the
 *       matching keys and never touches non-matching keys.
 *   P6. Breaker recovery — after the recovery cooldown elapses (fake clock),
 *       the breaker leaves OPEN and probes the backend again (HALF_OPEN).
 *   P7. Idempotent delete — deleting an absent key is a no-op that never throws.
 *
 * Touch-policy: regression-only, append-only. Does not modify production code.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';

import {
  RedisCircuitBreakerWrapper,
  type RedisClientLike,
} from '../../src/infrastructure/db/redis-circuit-breaker-wrapper.js';
import { deleteRedisKeysMatchingPattern } from '../../src/infrastructure/db/redis-delete-by-pattern.js';
import type { RedisClient } from '../../src/infrastructure/db/redis-client.js';
import { globalCircuitBreakerRegistry } from '../../src/domain/observability/circuit-breaker-registry.js';
import {
  createCircuitBreaker,
  type CircuitBreaker,
} from '../../src/domain/shared/circuit-breaker/circuit-breaker.js';

const RUNS = 100;

// Mirrors the wrapper's production breaker thresholds so recovery-timing
// assertions reference the same cooldown the wrapper actually uses.
const REDIS_RECOVERY_TIMEOUT_MS = 15_000;

// ────────────────────────────────────────────────────────────────────────────
// In-memory mock Redis — implements the `RedisClientLike` seam the wrapper
// intercepts, plus `scanIterator` + `del` for the pattern-delete helper. No
// real socket, no real Redis. A `failNext` flag lets a property force the
// underlying op to throw so we can drive the breaker / infra-error path.
// ────────────────────────────────────────────────────────────────────────────
interface MockRedis extends RedisClientLike {
  readonly store: Map<string, string>;
  readonly getCalls: { count: number };
  fail: boolean;
}

function makeMockRedis(initial: ReadonlyMap<string, string> = new Map()): MockRedis {
  const store = new Map<string, string>(initial);
  const getCalls = { count: 0 };
  const self: MockRedis = {
    store,
    getCalls,
    fail: false,
    async get(key: string): Promise<string | null> {
      getCalls.count += 1;
      if (self.fail) throw new Error('ECONNREFUSED');
      return store.has(key) ? (store.get(key) as string) : null;
    },
    async set(key: string, value: string | number): Promise<unknown> {
      if (self.fail) throw new Error('ECONNREFUSED');
      store.set(key, String(value));
      return 'OK';
    },
    async del(key: string | string[]): Promise<unknown> {
      if (self.fail) throw new Error('ECONNREFUSED');
      const keys = Array.isArray(key) ? key : [key];
      let removed = 0;
      for (const k of keys) {
        if (store.delete(k)) removed += 1;
      }
      return removed;
    },
    async ping(): Promise<string> {
      if (self.fail) throw new Error('ECONNREFUSED');
      return 'PONG';
    },
  };
  return self;
}

afterEach(() => {
  globalCircuitBreakerRegistry.clear();
  vi.useRealTimers();
});

// ────────────────────────────────────────────────────────────────────────────
// P1. Cache miss → null fallback (no throw)
// ────────────────────────────────────────────────────────────────────────────
describe('Redis cache miss → null fallback (graceful degradation)', () => {
  it('any absent key resolves to null without throwing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (key) => {
        globalCircuitBreakerRegistry.clear();
        const mock = makeMockRedis(); // empty store → every key is a miss
        const wrapper = new RedisCircuitBreakerWrapper(mock);
        const result = await wrapper.get(key);
        expect(result).toBeNull();
        const typed = await wrapper.getTyped(key);
        expect(typed.kind).toBe('miss');
      }),
      { numRuns: RUNS },
    );
  });

  it('infra error on get collapses to null (never throws into hot path)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (key) => {
        globalCircuitBreakerRegistry.clear();
        const mock = makeMockRedis();
        mock.fail = true; // every underlying get throws
        const wrapper = new RedisCircuitBreakerWrapper(mock);
        const result = await wrapper.get(key);
        expect(result).toBeNull();
        const typed = await wrapper.getTyped(key);
        expect(typed.kind).toBe('infra_error');
      }),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P2. Breaker open → fallback without hitting Redis
// ────────────────────────────────────────────────────────────────────────────
describe('Redis breaker OPEN → fallback without touching backend', () => {
  it('OPEN breaker returns null and never invokes the underlying client', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (key) => {
        globalCircuitBreakerRegistry.clear();
        const mock = makeMockRedis(new Map([[key, 'should-not-be-read']]));
        const wrapper = new RedisCircuitBreakerWrapper(mock);
        wrapper.forceOpen();

        const before = mock.getCalls.count;
        const result = await wrapper.get(key);
        const typed = await wrapper.getTyped(key);

        expect(result).toBeNull(); // fallback even though store HAS the key
        expect(typed.kind).toBe('breaker_open');
        expect(mock.getCalls.count).toBe(before); // backend never hit
      }),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P3. get/set round-trip
// ────────────────────────────────────────────────────────────────────────────
describe('Redis get/set round-trip', () => {
  it('set(k, v) then get(k) returns v verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ maxLength: 256 }),
        async (key, value) => {
          globalCircuitBreakerRegistry.clear();
          const mock = makeMockRedis();
          const wrapper = new RedisCircuitBreakerWrapper(mock);
          await wrapper.set(key, value);
          const result = await wrapper.get(key);
          expect(result).toBe(value);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P4. Korean key/value round-trip
// ────────────────────────────────────────────────────────────────────────────
describe('Redis Korean (한글) key/value round-trip', () => {
  // Hangul syllable block + a few common standalone particles; values mix
  // Hangul with ASCII to catch any byte-truncation at the boundary.
  const koreanText = fc.stringMatching(/^[가-힣\s]{1,32}$/u);

  it('Korean keys and values survive the round-trip byte-for-byte', async () => {
    await fc.assert(
      fc.asyncProperty(koreanText, koreanText, async (key, value) => {
        globalCircuitBreakerRegistry.clear();
        const mock = makeMockRedis();
        const wrapper = new RedisCircuitBreakerWrapper(mock);
        await wrapper.set(key, value);
        const result = await wrapper.get(key);
        expect(result).toBe(value);
      }),
      { numRuns: RUNS },
    );
  });

  it('fixed Korean wine-domain string survives the round-trip', async () => {
    globalCircuitBreakerRegistry.clear();
    const mock = makeMockRedis();
    const wrapper = new RedisCircuitBreakerWrapper(mock);
    const key = '캐시:와인:부르고뉴';
    const value = '레드 와인 — 피노 누아 100%, 가격 70000원';
    await wrapper.set(key, value);
    expect(await wrapper.get(key)).toBe(value);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P5. delete-by-pattern is bounded — never deletes non-matching keys
// ────────────────────────────────────────────────────────────────────────────
describe('Redis delete-by-pattern is bounded', () => {
  // Minimal scanIterator-backed mock matching the `RedisClient` surface used by
  // `deleteRedisKeysMatchingPattern`. Supports prefix-glob (`prefix:*`) MATCH.
  function makeScanMock(initial: ReadonlyMap<string, string>): {
    redis: Pick<RedisClient, 'scanIterator' | 'del'>;
    store: Map<string, string>;
  } {
    const store = new Map<string, string>(initial);
    const redis = {
      scanIterator(opts: { MATCH?: string; COUNT?: number }) {
        const match = opts.MATCH ?? '*';
        const prefix = match.endsWith('*') ? match.slice(0, -1) : match;
        const exact = !match.endsWith('*');
        const keys = [...store.keys()].filter((k) =>
          exact ? k === match : k.startsWith(prefix),
        );
        return (async function* () {
          for (const k of keys) yield k;
        })();
      },
      async del(key: string | string[]): Promise<number> {
        const ks = Array.isArray(key) ? key : [key];
        let n = 0;
        for (const k of ks) if (store.delete(k)) n += 1;
        return n;
      },
    } as unknown as Pick<RedisClient, 'scanIterator' | 'del'>;
    return { redis, store };
  }

  it('pattern delete removes only matching keys and leaves others intact', async () => {
    const prefix = 'wine:query:';
    // Suffix / key fragments restricted to a glob-neutral alphanumeric alphabet
    // so generated strings cannot accidentally embed `*` or `:` and blur the
    // matching/non-matching partition the property asserts on.
    const fragment = fc
      .stringMatching(/^[a-zA-Z0-9]{1,24}$/u)
      .filter((s) => s.length > 0);
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fragment, { minLength: 0, maxLength: 20 }),
        fc.uniqueArray(fragment, { minLength: 0, maxLength: 20 }),
        async (matchingSuffixes, otherSuffixes) => {
          const seed = new Map<string, string>();
          const matchingKeys = matchingSuffixes.map((s) => `${prefix}${s}`);
          // "Other" keys live under a deliberately disjoint namespace so they
          // can never share the matched prefix.
          const otherKeys = otherSuffixes.map((s) => `wine:entity:${s}`);
          for (const k of matchingKeys) seed.set(k, 'v');
          for (const k of otherKeys) seed.set(k, 'v');

          // `makeScanMock` owns the live store the helper mutates; assert on it
          // (not the seed copy).
          const { redis, store } = makeScanMock(seed);
          const deleted = await deleteRedisKeysMatchingPattern(
            redis as unknown as RedisClient,
            `${prefix}*`,
          );

          // Exactly the matching keys are removed.
          expect(deleted).toBe(new Set(matchingKeys).size);
          for (const k of matchingKeys) expect(store.has(k)).toBe(false);
          // Every non-matching key survives.
          for (const k of otherKeys) expect(store.has(k)).toBe(true);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P6. Breaker recovery — after cooldown the breaker probes again (HALF_OPEN)
//     Uses vi.useFakeTimers() as the injectable clock (circuit-breaker reads
//     Date.now()). We assert the OPEN → HALF_OPEN transition is gated strictly
//     by the recovery window: JUST inside still OPEN, JUST past → HALF_OPEN.
// ────────────────────────────────────────────────────────────────────────────
describe('Redis breaker recovery after cooldown (injectable clock)', () => {
  it('breaker stays OPEN before cooldown and probes (HALF_OPEN) once it elapses', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000 }), (slack) => {
        vi.useFakeTimers();
        try {
          const breaker: CircuitBreaker = createCircuitBreaker({
            name: `redis-recovery-${String(slack)}`,
            failureThreshold: 1,
            recoveryTimeoutMs: REDIS_RECOVERY_TIMEOUT_MS,
            halfOpenMaxAttempts: 2,
          });
          breaker.forceOpen();
          expect(breaker.state).toBe('OPEN');

          // JUST inside the window → still OPEN (no premature probe).
          vi.advanceTimersByTime(REDIS_RECOVERY_TIMEOUT_MS - 1);
          expect(breaker.state).toBe('OPEN');

          // Cross the threshold (+ random slack) → lazy transition to HALF_OPEN.
          vi.advanceTimersByTime(1 + slack);
          expect(breaker.state).toBe('HALF_OPEN');
        } finally {
          vi.useRealTimers();
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('after recovery a successful probe re-invokes the backend (cache live again)', async () => {
    vi.useFakeTimers();
    try {
      globalCircuitBreakerRegistry.clear();
      const mock = makeMockRedis(new Map([['k', 'cached-value']]));
      const wrapper = new RedisCircuitBreakerWrapper(mock);
      wrapper.forceOpen();
      expect(await wrapper.get('k')).toBeNull(); // OPEN → fallback

      vi.advanceTimersByTime(REDIS_RECOVERY_TIMEOUT_MS + 1); // cooldown elapses
      const before = mock.getCalls.count;
      const result = await wrapper.get('k'); // HALF_OPEN probe hits backend
      expect(mock.getCalls.count).toBe(before + 1);
      expect(result).toBe('cached-value');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P7. Idempotent delete — deleting an absent key is a safe no-op
// ────────────────────────────────────────────────────────────────────────────
describe('Redis idempotent delete', () => {
  it('deleting an absent key never throws and removes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 64 }), async (key) => {
        globalCircuitBreakerRegistry.clear();
        const mock = makeMockRedis(); // empty store
        const wrapper = new RedisCircuitBreakerWrapper(mock);
        const typed = await wrapper.delTyped(key);
        expect(typed.kind).toBe('ok'); // del of missing key is a clean no-op
        expect(mock.store.size).toBe(0);
        // Calling del again is still a no-op (idempotent).
        await wrapper.del(key);
        expect(mock.store.size).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });
});
