/**
 * Property-based + state-machine regression tests for the circuit-breaker
 * primitive (Netflix Hystrix-style three-state machine).
 *
 * Scope: focuses on the primitive itself (`CircuitBreakerImpl`), independent
 * of the registry singleton. The registry-level properties live in
 * `circuit-breaker-registry-properties.regression.test.ts`.
 *
 * Goals (SOTA++ grade, append-only):
 *   - State-machine invariants over random failure-count distributions
 *     (fast-check, numRuns: 100).
 *   - Deterministic / injectable clock via `vi.useFakeTimers()` —
 *     no real wall-clock delays.
 *   - Boundary tests for the failure-threshold transition (rule 18:
 *     off-by-one majority/threshold checks).
 *   - Half-open semantics: probe success returns to closed, probe
 *     failure re-opens with cooldown timer reset (extended cooldown).
 *   - Determinism: same event sequence + same fake clock → identical
 *     observable state across two independent breakers.
 *
 * Hystrix semantics being asserted:
 *   1) CLOSED stays CLOSED while consecutive failures < threshold.
 *   2) CLOSED → OPEN on the (threshold)-th consecutive failure.
 *   3) Any success in CLOSED resets the failure streak to 0.
 *   4) OPEN with `elapsed < recoveryTimeoutMs` stays OPEN.
 *   5) OPEN with `elapsed >= recoveryTimeoutMs` reads as HALF_OPEN.
 *   6) HALF_OPEN + `halfOpenMaxAttempts` consecutive probe successes → CLOSED.
 *   7) HALF_OPEN + single probe failure → OPEN with `openedAt` reset to now
 *      (cooldown restarted, never shorter than the previous one).
 *   8) failureCount in CLOSED is monotonically non-decreasing between
 *      success-resets.
 *   9) Initial state with zero calls is CLOSED.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import {
  CircuitBreakerImpl,
  type CircuitBreaker,
  type CircuitBreakerOptions,
} from '../../src/domain/shared/circuit-breaker/circuit-breaker.js';

const FAILURE_THRESHOLD = 4;
const RECOVERY_TIMEOUT_MS = 2_000;
const HALF_OPEN_ATTEMPTS = 2;

function makeBreaker(name: string, over: Partial<CircuitBreakerOptions> = {}): CircuitBreaker {
  const opts: CircuitBreakerOptions = {
    name,
    failureThreshold: FAILURE_THRESHOLD,
    recoveryTimeoutMs: RECOVERY_TIMEOUT_MS,
    halfOpenMaxAttempts: HALF_OPEN_ATTEMPTS,
    ...over,
  };
  return new CircuitBreakerImpl(opts);
}

describe('Initial state', () => {
  it('a fresh breaker with zero calls is CLOSED with failureCount=0', () => {
    const cb = makeBreaker('init');
    const m = cb.getMetrics();
    expect(m.state).toBe('CLOSED');
    expect(m.failureCount).toBe(0);
    expect(m.openCount).toBe(0);
    expect(m.lastFailureTime).toBeUndefined();
  });
});

describe('Property: CLOSED → OPEN requires N >= threshold consecutive failures', () => {
  it('any random N >= threshold lands the breaker in OPEN (fast-check 100 runs)', () => {
    fc.assert(
      fc.property(fc.integer({ min: FAILURE_THRESHOLD, max: 500 }), (n) => {
        const cb = makeBreaker('prop-open');
        for (let i = 0; i < n; i += 1) cb.recordFailure();
        return cb.getMetrics().state === 'OPEN';
      }),
      { numRuns: 100 },
    );
  });

  it('any random N < threshold keeps the breaker CLOSED (fast-check 100 runs)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: FAILURE_THRESHOLD - 1 }), (n) => {
        const cb = makeBreaker('prop-closed');
        for (let i = 0; i < n; i += 1) cb.recordFailure();
        const m = cb.getMetrics();
        return m.state === 'CLOSED' && m.failureCount === n;
      }),
      { numRuns: 100 },
    );
  });
});

describe('Boundary: off-by-one around failureThreshold (rule 18)', () => {
  it('exactly threshold-1 failures → still CLOSED', () => {
    const cb = makeBreaker('boundary-just-under');
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) cb.recordFailure();
    expect(cb.getMetrics().state).toBe('CLOSED');
    expect(cb.getMetrics().failureCount).toBe(FAILURE_THRESHOLD - 1);
  });

  it('exactly threshold failures → OPEN (transition fires on the Nth failure, not the N+1th)', () => {
    const cb = makeBreaker('boundary-at-threshold');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    expect(cb.getMetrics().state).toBe('OPEN');
    expect(cb.getMetrics().openCount).toBe(1);
  });

  it('threshold + 1 failures → still OPEN (extra failure absorbed, no double-open)', () => {
    const cb = makeBreaker('boundary-over');
    for (let i = 0; i < FAILURE_THRESHOLD + 1; i += 1) cb.recordFailure();
    const m = cb.getMetrics();
    expect(m.state).toBe('OPEN');
    // openCount must NOT double-count failures recorded while already OPEN.
    expect(m.openCount).toBe(1);
  });
});

describe('Property: success in CLOSED resets failureCount (regardless of accumulated count)', () => {
  it('any single success after K failures (K < threshold) returns failureCount to 0', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: FAILURE_THRESHOLD - 1 }), (k) => {
        const cb = makeBreaker('prop-success-reset');
        for (let i = 0; i < k; i += 1) cb.recordFailure();
        cb.recordSuccess();
        return cb.getMetrics().failureCount === 0 && cb.getMetrics().state === 'CLOSED';
      }),
      { numRuns: 100 },
    );
  });
});

describe('Property: counter monotonicity in CLOSED', () => {
  it('consecutive failures (no successes) never decrease failureCount until threshold trip', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: FAILURE_THRESHOLD - 1 }), (n) => {
        const cb = makeBreaker('prop-monotonic');
        let prev = 0;
        for (let i = 0; i < n; i += 1) {
          cb.recordFailure();
          const cur = cb.getMetrics().failureCount;
          if (cur < prev) return false;
          prev = cur;
        }
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

describe('Cooldown invariant with deterministic clock (vi.useFakeTimers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('OPEN with elapsed < recoveryTimeoutMs stays OPEN', () => {
    const cb = makeBreaker('cool-stays');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    expect(cb.state).toBe('OPEN');

    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS - 1);
    expect(cb.state).toBe('OPEN');
    expect(cb.getMetrics().state).toBe('OPEN');
  });

  it('OPEN with elapsed >= recoveryTimeoutMs lazy-transitions to HALF_OPEN on read', () => {
    const cb = makeBreaker('cool-half');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    expect(cb.state).toBe('OPEN');

    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS);
    // Observation via `state` triggers lazy transition.
    expect(cb.state).toBe('HALF_OPEN');
    expect(cb.getMetrics().state).toBe('HALF_OPEN');
  });

  it('HALF_OPEN + halfOpenMaxAttempts consecutive successes → CLOSED with failureCount=0', () => {
    const cb = makeBreaker('half-close');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS);
    expect(cb.state).toBe('HALF_OPEN');

    for (let i = 0; i < HALF_OPEN_ATTEMPTS; i += 1) cb.recordSuccess();
    expect(cb.getMetrics().state).toBe('CLOSED');
    expect(cb.getMetrics().failureCount).toBe(0);
  });

  it('HALF_OPEN + single probe failure → OPEN with cooldown timer RESET (extended cooldown)', () => {
    const cb = makeBreaker('half-reopen');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS);
    expect(cb.state).toBe('HALF_OPEN');

    // Probe fails → reopen, openedAt must reset to "now".
    cb.recordFailure();
    expect(cb.getMetrics().state).toBe('OPEN');
    expect(cb.getMetrics().openCount).toBe(2); // counted: first trip + re-trip

    // From this moment, a FULL fresh cooldown must elapse before HALF_OPEN.
    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS - 1);
    expect(cb.state).toBe('OPEN');
    vi.advanceTimersByTime(1);
    expect(cb.state).toBe('HALF_OPEN');
  });

  it('Property: deterministic clock — same failure sequence + same clock → same state across two breakers', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<'F' | 'S'>('F', 'S'), { minLength: 0, maxLength: 20 }),
        (events) => {
          const a = makeBreaker('det-a');
          const b = makeBreaker('det-b');
          for (const e of events) {
            if (e === 'F') {
              a.recordFailure();
              b.recordFailure();
            } else {
              a.recordSuccess();
              b.recordSuccess();
            }
          }
          const ma = a.getMetrics();
          const mb = b.getMetrics();
          return (
            ma.state === mb.state &&
            ma.failureCount === mb.failureCount &&
            ma.openCount === mb.openCount
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('forceOpen / forceClose surface (administrative override)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-21T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forceOpen on a CLOSED breaker trips it and records openCount=1', () => {
    const cb = makeBreaker('force-open');
    expect(cb.getMetrics().state).toBe('CLOSED');
    cb.forceOpen();
    expect(cb.getMetrics().state).toBe('OPEN');
    expect(cb.getMetrics().openCount).toBe(1);
  });

  it('forceClose on an OPEN breaker resets failureCount and clears openedAt', () => {
    const cb = makeBreaker('force-close');
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) cb.recordFailure();
    expect(cb.getMetrics().state).toBe('OPEN');
    cb.forceClose();
    expect(cb.getMetrics().state).toBe('CLOSED');
    expect(cb.getMetrics().failureCount).toBe(0);
    // After forceClose, advancing the clock must NOT lazy-transition to HALF_OPEN.
    vi.advanceTimersByTime(RECOVERY_TIMEOUT_MS * 10);
    expect(cb.state).toBe('CLOSED');
  });
});
