/**
 * Regression suite for the OpenAI key pool's rotation, rate-limit health
 * tracking, and fail-over semantics.
 *
 * Goals (SOTA++ grade, append-only):
 *  - Deterministic round-robin across N keys via `acquire()`
 *  - Rate-limited keys are skipped until their cooldown elapses
 *  - Recovery is driven by an injected clock (no real timers)
 *  - "All exhausted" is observable: `acquire()` returns null
 *  - `getStats()` exposes pool health (keyCount, exhaustedCount, totalAcquires)
 *  - Backward-compat: `createOpenAiKeyPool` / `orderedOpenAiKeySlots` /
 *    `isOpenAiKeyPoolRotatableError` / `openAiKeyPoolExhaustedError` exports
 *    keep their existing surfaces.
 *
 * Adjacent regressions (rule 4):
 *  - Empty pool init throws (factory contract)
 *  - Distinct rotation increments across multiple acquires from one pool
 *  - Interleaved rate-limit / recovery using clock advance
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createOpenAiKeyPool,
  orderedOpenAiKeySlots,
  isOpenAiKeyPoolRotatableError,
  openAiKeyPoolExhaustedError,
  OpenAiKeyPool,
  type OpenAiKeyPoolClock,
} from '../../src/infrastructure/ai/openai-key-pool.js';
import { globalCircuitBreakerRegistry } from '../../src/domain/observability/circuit-breaker-registry.js';

const FAILURE_THRESHOLD = 5;
const RECOVERY_TIMEOUT_MS = 60_000;
const HALF_OPEN_ATTEMPTS = 1;
const COOLDOWN_MS = 30_000;

function makeClock(): OpenAiKeyPoolClock & { advance(ms: number): void; set(ms: number): void } {
  let now = 1_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

function newPool(
  baseName: string,
  keys: readonly string[],
  clock: OpenAiKeyPoolClock,
  cooldownMs: number = COOLDOWN_MS,
): OpenAiKeyPool {
  return new OpenAiKeyPool({
    baseBreakerName: baseName,
    apiKeys: keys,
    failureThreshold: FAILURE_THRESHOLD,
    recoveryTimeoutMs: RECOVERY_TIMEOUT_MS,
    halfOpenMaxAttempts: HALF_OPEN_ATTEMPTS,
    rateLimitCooldownMs: cooldownMs,
    clock,
  });
}

beforeEach(() => {
  globalCircuitBreakerRegistry.clear();
});

describe('OpenAiKeyPool round-robin rotation', () => {
  it('cycles through 3 keys across 6 consecutive acquires (1→2→3→1→2→3)', () => {
    const clock = makeClock();
    const pool = newPool('rr-3', ['k-a', 'k-b', 'k-c'], clock);

    const expectedOrder = ['k-a', 'k-b', 'k-c', 'k-a', 'k-b', 'k-c'];
    const observed: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const slot = pool.acquire();
      expect(slot).not.toBeNull();
      observed.push(slot!.apiKey);
    }
    expect(observed).toEqual(expectedOrder);
  });

  it('single-key pool always returns the sole key', () => {
    const clock = makeClock();
    const pool = newPool('rr-1', ['only-k'], clock);
    for (let i = 0; i < 4; i += 1) {
      const slot = pool.acquire();
      expect(slot?.apiKey).toBe('only-k');
    }
  });
});

describe('OpenAiKeyPool rate-limit skip / recovery (injectable clock)', () => {
  it('marks key1 rate-limited → next acquire skips to key2', () => {
    const clock = makeClock();
    const pool = newPool('skip-1', ['k1', 'k2', 'k3'], clock);

    const first = pool.acquire();
    expect(first?.apiKey).toBe('k1');

    pool.markRateLimited(first!.apiKey);

    const second = pool.acquire();
    expect(second?.apiKey).toBe('k2');
  });

  it('recovers a rate-limited key once cooldown elapses (via injected clock)', () => {
    const clock = makeClock();
    const pool = newPool('recover-1', ['k1', 'k2'], clock, COOLDOWN_MS);

    const first = pool.acquire();
    expect(first?.apiKey).toBe('k1');
    pool.markRateLimited('k1');

    // While still in cooldown, k1 must be skipped.
    const duringCooldown = pool.acquire();
    expect(duringCooldown?.apiKey).toBe('k2');

    // Advance just under the cooldown — still exhausted.
    clock.advance(COOLDOWN_MS - 1);
    pool.markRateLimited('k2'); // exhaust k2 too so we can observe k1 recovery
    const stillExhausted = pool.acquire();
    expect(stillExhausted).toBeNull();

    // Advance past k1's cooldown — k1 should become available again.
    clock.advance(2);
    const recovered = pool.acquire();
    expect(recovered?.apiKey).toBe('k1');
  });

  it('returns null when every key is rate-limited (all exhausted)', () => {
    const clock = makeClock();
    const pool = newPool('all-exhausted', ['k1', 'k2'], clock);

    pool.markRateLimited('k1');
    pool.markRateLimited('k2');

    expect(pool.acquire()).toBeNull();
  });

  it('single-key pool returns null while that key is rate-limited', () => {
    const clock = makeClock();
    const pool = newPool('single-exhausted', ['only-k'], clock);

    pool.markRateLimited('only-k');
    expect(pool.acquire()).toBeNull();

    clock.advance(COOLDOWN_MS + 1);
    expect(pool.acquire()?.apiKey).toBe('only-k');
  });
});

describe('OpenAiKeyPool.getStats()', () => {
  it('reports keyCount, exhaustedCount, totalAcquires accurately', () => {
    const clock = makeClock();
    const pool = newPool('stats-1', ['k1', 'k2', 'k3'], clock);

    expect(pool.getStats()).toEqual({
      keyCount: 3,
      exhaustedCount: 0,
      totalAcquires: 0,
    });

    pool.acquire();
    pool.acquire();
    expect(pool.getStats().totalAcquires).toBe(2);

    pool.markRateLimited('k1');
    expect(pool.getStats()).toEqual({
      keyCount: 3,
      exhaustedCount: 1,
      totalAcquires: 2,
    });

    // After cooldown elapses, exhaustedCount drops back to 0.
    clock.advance(COOLDOWN_MS + 1);
    expect(pool.getStats().exhaustedCount).toBe(0);
  });

  it('totalAcquires does not increment when acquire() returns null', () => {
    const clock = makeClock();
    const pool = newPool('stats-null', ['only-k'], clock);
    pool.markRateLimited('only-k');

    expect(pool.acquire()).toBeNull();
    expect(pool.getStats().totalAcquires).toBe(0);
  });
});

describe('OpenAiKeyPool adjacent regressions', () => {
  it('empty pool init throws (no silent zero-key state)', () => {
    const clock = makeClock();
    expect(() =>
      newPool('empty', [], clock),
    ).toThrow(/at least one API key/i);
  });

  it('distinct counter increments across multiple acquires from one pool', () => {
    const clock = makeClock();
    const pool = newPool('counter', ['k1', 'k2'], clock);

    for (let i = 0; i < 5; i += 1) {
      pool.acquire();
    }
    expect(pool.getStats().totalAcquires).toBe(5);
  });

  it('interleaved rate-limit + recovery sequence stays deterministic', () => {
    const clock = makeClock();
    const pool = newPool('interleave', ['k1', 'k2', 'k3'], clock, 10_000);

    // step 1: acquire k1, then mark it rate-limited
    expect(pool.acquire()?.apiKey).toBe('k1');
    pool.markRateLimited('k1');

    // step 2: next acquire must skip to k2
    expect(pool.acquire()?.apiKey).toBe('k2');

    // step 3: mark k2 rate-limited; advance halfway through both cooldowns
    pool.markRateLimited('k2');
    clock.advance(5_000);

    // step 4: only k3 is healthy
    expect(pool.acquire()?.apiKey).toBe('k3');

    // step 5: advance past k1's cooldown; k1 recovers but k2 still exhausted
    clock.advance(5_001); // total since k1 mark = 10_001ms, since k2 mark = 5_001ms
    // Rotation continues; next slot index points past k3 → wraps to k1.
    const next = pool.acquire();
    expect(next?.apiKey).toBe('k1');

    // step 6: advance past k2's cooldown; k2 also recovers
    clock.advance(5_000);
    expect(pool.getStats().exhaustedCount).toBe(0);
  });
});

describe('OpenAiKeyPool backward-compat surface (functional exports unchanged)', () => {
  it('createOpenAiKeyPool still returns readonly slot array with breakers', () => {
    const slots = createOpenAiKeyPool({
      baseBreakerName: 'compat-1',
      apiKeys: ['a', 'b'],
      failureThreshold: FAILURE_THRESHOLD,
      recoveryTimeoutMs: RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: HALF_OPEN_ATTEMPTS,
    });
    expect(slots.length).toBe(2);
    expect(slots[0]?.apiKey).toBe('a');
    expect(slots[0]?.breakerName).toBe('compat-1:key-1');
    expect(slots[1]?.breakerName).toBe('compat-1:key-2');
    expect(typeof slots[0]?.circuitBreaker.execute).toBe('function');
  });

  it('orderedOpenAiKeySlots rotates starting from the given index', () => {
    const slots = createOpenAiKeyPool({
      baseBreakerName: 'compat-2',
      apiKeys: ['a', 'b', 'c'],
      failureThreshold: FAILURE_THRESHOLD,
      recoveryTimeoutMs: RECOVERY_TIMEOUT_MS,
      halfOpenMaxAttempts: HALF_OPEN_ATTEMPTS,
    });
    const ordered = orderedOpenAiKeySlots(slots, 1).map((s) => s.apiKey);
    expect(ordered).toEqual(['b', 'c', 'a']);
  });

  it('isOpenAiKeyPoolRotatableError recognises 429 / 408 / 5xx / auth errors', () => {
    expect(isOpenAiKeyPoolRotatableError({ status: 429 })).toBe(true);
    expect(isOpenAiKeyPoolRotatableError({ status: 408 })).toBe(true);
    expect(isOpenAiKeyPoolRotatableError({ status: 503 })).toBe(true);
    expect(isOpenAiKeyPoolRotatableError({ status: 401 })).toBe(true);
    expect(isOpenAiKeyPoolRotatableError({ status: 400 })).toBe(false);
    expect(isOpenAiKeyPoolRotatableError(new Error('plain'))).toBe(false);
  });

  it('openAiKeyPoolExhaustedError includes key count and last error preview', () => {
    const err = openAiKeyPoolExhaustedError('OpenAI test', 3, [new Error('rate limited')]);
    expect(err.message).toMatch(/OpenAI test key pool exhausted \(3 keys attempted\)/);
    expect(err.message).toMatch(/rate limited/);
  });
});
