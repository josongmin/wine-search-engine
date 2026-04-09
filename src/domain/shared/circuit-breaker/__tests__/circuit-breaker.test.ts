import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerOpenError } from '../../error/circuit-breaker-open-error.js';
import {
  CircuitBreakerImpl,
  type CircuitBreakerOptions,
  createCircuitBreaker,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_HALF_OPEN_ATTEMPTS,
  DEFAULT_RECOVERY_TIMEOUT_MS,
} from '../circuit-breaker.js';

const baseOpts = (over: Partial<CircuitBreakerOptions> = {}): CircuitBreakerOptions => ({
  name: 'test-breaker',
  failureThreshold: 3,
  recoveryTimeoutMs: 10_000,
  halfOpenMaxAttempts: 2,
  ...over,
});

const failing = async (): Promise<never> => {
  throw new Error('boom');
};
const succeeding = async (): Promise<string> => 'ok';

describe('CircuitBreakerImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-09T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor validation', () => {
    it('rejects non-positive failureThreshold', () => {
      expect(() => new CircuitBreakerImpl(baseOpts({ failureThreshold: 0 }))).toThrow();
    });
    it('rejects negative recoveryTimeoutMs', () => {
      expect(() => new CircuitBreakerImpl(baseOpts({ recoveryTimeoutMs: -1 }))).toThrow();
    });
    it('rejects non-positive halfOpenMaxAttempts', () => {
      expect(() => new CircuitBreakerImpl(baseOpts({ halfOpenMaxAttempts: 0 }))).toThrow();
    });
  });

  describe('CLOSED → OPEN', () => {
    it('stays CLOSED under the failure threshold', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      await expect(cb.execute(failing)).rejects.toThrow('boom');
      await expect(cb.execute(failing)).rejects.toThrow('boom');
      expect(cb.state).toBe('CLOSED');
      expect(cb.getMetrics().failureCount).toBe(2);
    });

    it('trips to OPEN after threshold consecutive failures', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      for (let i = 0; i < 3; i += 1) {
        await expect(cb.execute(failing)).rejects.toThrow('boom');
      }
      expect(cb.state).toBe('OPEN');
      expect(cb.getMetrics().openCount).toBe(1);
    });

    it('resets failureCount on success in CLOSED', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      await expect(cb.execute(failing)).rejects.toThrow();
      await expect(cb.execute(failing)).rejects.toThrow();
      await expect(cb.execute(succeeding)).resolves.toBe('ok');
      expect(cb.getMetrics().failureCount).toBe(0);
      // Another 3 failures are required now to trip.
      await expect(cb.execute(failing)).rejects.toThrow();
      await expect(cb.execute(failing)).rejects.toThrow();
      expect(cb.state).toBe('CLOSED');
    });
  });

  describe('OPEN behavior', () => {
    it('throws CircuitBreakerOpenError without calling fn while OPEN', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      for (let i = 0; i < 3; i += 1) {
        await expect(cb.execute(failing)).rejects.toThrow('boom');
      }
      const spy = vi.fn(async () => 'should-not-run');
      await expect(cb.execute(spy)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('rejects concurrent execute calls in OPEN state', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      for (let i = 0; i < 3; i += 1) {
        await expect(cb.execute(failing)).rejects.toThrow('boom');
      }
      const spy = vi.fn(async () => 'x');
      const results = await Promise.allSettled([
        cb.execute(spy),
        cb.execute(spy),
        cb.execute(spy),
      ]);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('OPEN → HALF_OPEN', () => {
    it('moves to HALF_OPEN after recoveryTimeoutMs elapses', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      for (let i = 0; i < 3; i += 1) {
        await expect(cb.execute(failing)).rejects.toThrow();
      }
      expect(cb.state).toBe('OPEN');
      vi.advanceTimersByTime(9_999);
      expect(cb.state).toBe('OPEN');
      vi.advanceTimersByTime(1);
      expect(cb.state).toBe('HALF_OPEN');
    });
  });

  describe('HALF_OPEN → CLOSED', () => {
    it('closes after halfOpenMaxAttempts successful probes', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      for (let i = 0; i < 3; i += 1) {
        await expect(cb.execute(failing)).rejects.toThrow();
      }
      vi.advanceTimersByTime(10_000);
      expect(cb.state).toBe('HALF_OPEN');
      await expect(cb.execute(succeeding)).resolves.toBe('ok');
      expect(cb.state).toBe('HALF_OPEN');
      await expect(cb.execute(succeeding)).resolves.toBe('ok');
      expect(cb.state).toBe('CLOSED');
      expect(cb.getMetrics().failureCount).toBe(0);
    });
  });

  describe('HALF_OPEN → OPEN', () => {
    it('reopens on any probe failure', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      for (let i = 0; i < 3; i += 1) {
        await expect(cb.execute(failing)).rejects.toThrow();
      }
      vi.advanceTimersByTime(10_000);
      expect(cb.state).toBe('HALF_OPEN');
      await expect(cb.execute(succeeding)).resolves.toBe('ok'); // 1 good probe
      await expect(cb.execute(failing)).rejects.toThrow('boom'); // fail → reopen
      expect(cb.state).toBe('OPEN');
      expect(cb.getMetrics().openCount).toBe(2);
    });

    it('gates concurrent HALF_OPEN probes to halfOpenMaxAttempts', async () => {
      const cb = new CircuitBreakerImpl(baseOpts({ halfOpenMaxAttempts: 2 }));
      for (let i = 0; i < 3; i += 1) {
        await expect(cb.execute(failing)).rejects.toThrow();
      }
      vi.advanceTimersByTime(10_000);
      expect(cb.state).toBe('HALF_OPEN');

      // Two probes hold the slots open; a third concurrent call must fast-fail.
      let release1: () => void = () => {};
      let release2: () => void = () => {};
      const p1 = cb.execute(
        () => new Promise<string>((res) => {
          release1 = () => res('a');
        }),
      );
      const p2 = cb.execute(
        () => new Promise<string>((res) => {
          release2 = () => res('b');
        }),
      );
      await expect(cb.execute(succeeding)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
      release1();
      release2();
      await expect(p1).resolves.toBe('a');
      await expect(p2).resolves.toBe('b');
      expect(cb.state).toBe('CLOSED');
    });
  });

  describe('forceOpen / forceClose', () => {
    it('forceOpen trips the breaker immediately', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      cb.forceOpen();
      expect(cb.state).toBe('OPEN');
      const spy = vi.fn(async () => 'x');
      await expect(cb.execute(spy)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
      expect(spy).not.toHaveBeenCalled();
      expect(cb.getMetrics().openCount).toBe(1);
    });

    it('forceClose resets failure state', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      await expect(cb.execute(failing)).rejects.toThrow();
      await expect(cb.execute(failing)).rejects.toThrow();
      cb.forceClose();
      expect(cb.state).toBe('CLOSED');
      expect(cb.getMetrics().failureCount).toBe(0);
      await expect(cb.execute(succeeding)).resolves.toBe('ok');
    });
  });

  describe('getMetrics', () => {
    it('omits lastFailureTime until the first failure', () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      const m = cb.getMetrics();
      expect(m.state).toBe('CLOSED');
      expect(m.failureCount).toBe(0);
      expect(m.openCount).toBe(0);
      expect(m.lastFailureTime).toBeUndefined();
    });

    it('records lastFailureTime after failure and does not self-transition on read', async () => {
      const cb = new CircuitBreakerImpl(baseOpts());
      for (let i = 0; i < 3; i += 1) {
        await expect(cb.execute(failing)).rejects.toThrow();
      }
      const m1 = cb.getMetrics();
      expect(m1.state).toBe('OPEN');
      expect(m1.lastFailureTime).toBeDefined();
      // Advance past recovery timeout — getMetrics should NOT silently move us
      // to HALF_OPEN. Only `state` (the lazy getter) or `execute` may.
      vi.advanceTimersByTime(10_000);
      expect(cb.getMetrics().state).toBe('OPEN');
      expect(cb.state).toBe('HALF_OPEN');
    });
  });

  describe('createCircuitBreaker factory', () => {
    it('applies documented defaults', () => {
      const cb = createCircuitBreaker({ name: 'svc' });
      expect(cb.state).toBe('CLOSED');
      expect(DEFAULT_FAILURE_THRESHOLD).toBe(5);
      expect(DEFAULT_RECOVERY_TIMEOUT_MS).toBe(60_000);
      expect(DEFAULT_HALF_OPEN_ATTEMPTS).toBe(3);
    });
  });
});
