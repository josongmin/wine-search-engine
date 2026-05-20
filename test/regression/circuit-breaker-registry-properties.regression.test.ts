/**
 * Property-based + state-machine regression tests for the circuit-breaker
 * registry and the underlying breaker primitive it exposes.
 *
 * Goals (SOTA++ grade, append-only):
 *  - State-machine invariants over random failure counts (fast-check, 100 runs)
 *  - Cooldown invariant verified with a deterministic clock (vi.useFakeTimers)
 *  - Half-open probe semantics: success closes, failure reopens (cooldown extended)
 *  - Counter monotonicity (failure count never decreases except on close reset)
 *  - Registry isolation across multiple named breakers
 *  - Prometheus-friendly snapshot export shape (`getRegistrySnapshot()`)
 *
 * The registry is a module-scope singleton. Each test calls `clear()` in
 * `beforeEach` to ensure isolation. Cooldown tests drive `Date.now()` via
 * `vi.useFakeTimers()` so no real wall-clock delays are needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import {
  CircuitBreakerImpl,
  type CircuitBreaker,
} from '../../src/domain/shared/circuit-breaker/circuit-breaker.js';
import { globalCircuitBreakerRegistry } from '../../src/domain/observability/circuit-breaker-registry.js';

const FAILURE_THRESHOLD = 5;
const RECOVERY_TIMEOUT_MS = 1_000;
const HALF_OPEN_ATTEMPTS = 2;

function makeBreaker(name: string): CircuitBreaker {
  return new CircuitBreakerImpl({
    name,
    failureThreshold: FAILURE_THRESHOLD,
    recoveryTimeoutMs: RECOVERY_TIMEOUT_MS,
    halfOpenMaxAttempts: HALF_OPEN_ATTEMPTS,
  });
}

beforeEach(() => {
  globalCircuitBreakerRegistry.clear();
});

describe('Property: CLOSED → OPEN after N >= threshold consecutive failures', () => {
  it('any random N >= threshold lands the breaker in OPEN', () => {
    fc.assert(
      fc.property(fc.integer({ min: FAILURE_THRESHOLD, max: 200 }), (n) => {
        const breaker = makeBreaker('prop-trip');
        for (let i = 0; i < n; i += 1) {
          breaker.recordFailure();
        }
        return breaker.getMetrics().state === 'OPEN';
      }),
      { numRuns: 100 },
    );
  });

  it('N < threshold keeps breaker CLOSED', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: FAILURE_THRESHOLD - 1 }), (n) => {
        const breaker = makeBreaker('prop-stay-closed');
        for (let i = 0; i < n; i += 1) {
          breaker.recordFailure();
        }
        return breaker.getMetrics().state === 'CLOSED';
      }),
      { numRuns: 100 },
    );
  });
});

describe('Property: Counter monotonicity (failure count never decreases in CLOSED without success-reset)', () => {
  it('over a random sequence of failures, failureCount is non-decreasing until threshold trips', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: FAILURE_THRESHOLD - 1 }), (n) => {
        const breaker = makeBreaker('prop-monotonic');
        let prev = 0;
        for (let i = 0; i < n; i += 1) {
          breaker.recordFailure();
          const cur = breaker.getMetrics().failureCount;
          if (cur < prev) return false;
          prev = cur;
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('single success in CLOSED resets failureCount to 0 (documented reset)', () => {
    const breaker = makeBreaker('reset');
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getMetrics().failureCount).toBe(2);
    breaker.recordSuccess();
    expect(breaker.getMetrics().failureCount).toBe(0);
  });
});

describe('Cooldown invariant (deterministic clock via fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('OPEN before cooldown elapses stays OPEN', () => {
    const breaker = makeBreaker('cool-stays-open');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) breaker.recordFailure();
    expect(breaker.getMetrics().state).toBe('OPEN');

    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS - 1);
    // `state` getter is the lazy-transition observer
    expect(breaker.state).toBe('OPEN');
  });

  it('OPEN with now >= openedAt + cooldown transitions to HALF_OPEN on next read', () => {
    const breaker = makeBreaker('cool-half-open');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) breaker.recordFailure();
    expect(breaker.state).toBe('OPEN');

    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS);
    expect(breaker.state).toBe('HALF_OPEN');
  });

  it('HALF_OPEN + N successful probes (N >= halfOpenMaxAttempts) → CLOSED', () => {
    const breaker = makeBreaker('half-close');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) breaker.recordFailure();
    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS);
    expect(breaker.state).toBe('HALF_OPEN');

    for (let i = 0; i < HALF_OPEN_ATTEMPTS; i += 1) breaker.recordSuccess();
    expect(breaker.getMetrics().state).toBe('CLOSED');
    expect(breaker.getMetrics().failureCount).toBe(0);
  });

  it('HALF_OPEN + single failure reopens AND extends cooldown (openedAt resets to now)', () => {
    const breaker = makeBreaker('half-reopen');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) breaker.recordFailure();
    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS);
    expect(breaker.state).toBe('HALF_OPEN');

    // Probe fails — should reopen and openedAt should reset to current time.
    breaker.recordFailure();
    expect(breaker.getMetrics().state).toBe('OPEN');

    // Cooldown extension: advancing by RECOVERY_TIMEOUT_MS - 1 should NOT
    // already place us in HALF_OPEN (the timer was reset on reopen).
    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS - 1);
    expect(breaker.state).toBe('OPEN');
    vi.advanceTimersByTime(1);
    expect(breaker.state).toBe('HALF_OPEN');
  });
});

describe('Registry isolation: two distinct breakers do not cross-pollute', () => {
  it('tripping breaker A leaves breaker B CLOSED', () => {
    const vespa = makeBreaker('vespa');
    const redis = makeBreaker('redis');
    globalCircuitBreakerRegistry.register('vespa', vespa);
    globalCircuitBreakerRegistry.register('redis', redis);

    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) vespa.recordFailure();

    expect(vespa.getMetrics().state).toBe('OPEN');
    expect(redis.getMetrics().state).toBe('CLOSED');
    expect(redis.getMetrics().failureCount).toBe(0);
  });

  it('property: 2 named breakers, random failure interleavings — only the per-name failure counts move', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b'), { minLength: 0, maxLength: 20 }),
        (events) => {
          globalCircuitBreakerRegistry.clear();
          const a = makeBreaker('a');
          const b = makeBreaker('b');
          globalCircuitBreakerRegistry.register('a', a);
          globalCircuitBreakerRegistry.register('b', b);

          let expectedA = 0;
          let expectedB = 0;
          for (const e of events) {
            if (e === 'a' && expectedA < FAILURE_THRESHOLD) {
              a.recordFailure();
              expectedA += 1;
            } else if (e === 'b' && expectedB < FAILURE_THRESHOLD) {
              b.recordFailure();
              expectedB += 1;
            }
          }
          return (
            a.getMetrics().failureCount === expectedA &&
            b.getMetrics().failureCount === expectedB
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Prometheus-friendly snapshot export', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('getRegistrySnapshot() returns [] for empty registry', () => {
    expect(globalCircuitBreakerRegistry.getRegistrySnapshot()).toEqual([]);
  });

  it('snapshot returns one entry per registered breaker with prom-compatible shape', () => {
    const vespa = makeBreaker('vespa');
    const redis = makeBreaker('redis');
    globalCircuitBreakerRegistry.register('vespa', vespa);
    globalCircuitBreakerRegistry.register('redis', redis);
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) vespa.recordFailure();

    const snap = globalCircuitBreakerRegistry.getRegistrySnapshot();
    expect(snap.length).toBe(2);

    const vespaEntry = snap.find((s) => s.name === 'vespa');
    const redisEntry = snap.find((s) => s.name === 'redis');

    // Shape assertions per-entry: lowercase Prometheus-style labels.
    expect(vespaEntry).toMatchObject({
      name: 'vespa',
      state: 'open',
      failures: FAILURE_THRESHOLD,
    });
    expect(typeof vespaEntry?.last_trip_ms).toBe('number');
    expect(Number.isFinite(vespaEntry?.last_trip_ms)).toBe(true);

    expect(redisEntry).toMatchObject({
      name: 'redis',
      state: 'closed',
      failures: 0,
    });
    // Never tripped → last_trip_ms must be omitted (exact optional).
    expect(redisEntry && 'last_trip_ms' in redisEntry).toBe(false);
  });

  it('snapshot state label uses kebab-case half-open (Prometheus convention)', () => {
    const b = makeBreaker('vespa');
    globalCircuitBreakerRegistry.register('vespa', b);
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) b.recordFailure();
    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS);
    // Force lazy transition via state getter
    expect(b.state).toBe('HALF_OPEN');

    const snap = globalCircuitBreakerRegistry.getRegistrySnapshot();
    expect(snap[0]?.state).toBe('half-open');
  });

  it('snapshot entries are typed with the documented union for state', () => {
    const b = makeBreaker('typed');
    globalCircuitBreakerRegistry.register('typed', b);
    const snap = globalCircuitBreakerRegistry.getRegistrySnapshot();
    expect(['closed', 'open', 'half-open']).toContain(snap[0]?.state);
  });
});
