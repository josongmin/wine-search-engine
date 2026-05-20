/**
 * Property-based regression tests for HTTP resilience (timeout + retry + backoff).
 *
 * These tests assert PROPERTIES (universal truths) rather than specific examples:
 *   - Backoff is monotonically non-decreasing in attempt number (until cap).
 *   - Jitter stays within the documented full-jitter envelope [0, expDelay).
 *   - Retry budget (maxAttempts) is honored EXACTLY — no off-by-one.
 *   - 5xx / 429 / transient network errors are retried; 4xx (non-429) are not.
 *   - Pre-aborted signal short-circuits with 0 fn calls.
 *   - Total wait time is bounded by the sum of per-attempt caps.
 *   - Retry-After header is honored as a floor.
 *   - Concurrent retry policies do not share state.
 *
 * Implementation under test:
 *   src/infrastructure/http/retry-with-backoff.ts
 *   src/infrastructure/http/fetch-with-timeout.ts
 *
 * Append-only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import {
  retryWithBackoff,
  type RetryConfig,
} from '../../src/infrastructure/http/retry-with-backoff.js';
import { fetchWithTimeout } from '../../src/infrastructure/http/fetch-with-timeout.js';

const PROPERTY_NUM_RUNS = 100;

const BASE_CONFIG: RetryConfig = {
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
  label: 'PropTest',
};

/**
 * Reference backoff formula derived from sleepWithJitter() and sleepRateLimit():
 *
 * Transient (5xx / network):
 *   expDelay = min(baseMs * 2^(attempt-1), capMs)
 *   delay    = floor(random() * expDelay)            // full-jitter envelope [0, expDelay)
 *
 * Rate-limit (429) without Retry-After:
 *   expDelay = min(rateLimitBaseMs * 2^(attempt-1), rateLimitCapMs)
 *   delay    = floor(random() * expDelay)
 *
 * Rate-limit (429) with Retry-After:
 *   floor    = min(retryAfterSec * 1000, rateLimitCapMs)
 *   jitter   = floor(random() * floor(floor * 0.25))
 *   delay    = floor + jitter
 */
function transientExpDelay(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}

describe('Property: retry backoff envelope (transient 5xx)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exponential expDelay is monotonically non-decreasing in attempt number (and capped)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 5_000 }),
        fc.integer({ min: 10, max: 60_000 }),
        fc.integer({ min: 1, max: 10 }),
        (baseMs, capMs, attempts) => {
          let prev = -1;
          for (let n = 1; n <= attempts; n++) {
            const cur = transientExpDelay(n, baseMs, capMs);
            // Monotonic non-decreasing
            expect(cur).toBeGreaterThanOrEqual(prev);
            // Always capped
            expect(cur).toBeLessThanOrEqual(capMs);
            // Always non-negative
            expect(cur).toBeGreaterThanOrEqual(0);
            prev = cur;
          }
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('jittered delay stays within full-jitter envelope [0, expDelay) for 100 random seeds', async () => {
    vi.useFakeTimers();

    // Run for attempt=2 to keep expDelay = min(250*2, 2000) = 500ms — bounded.
    const attempt = 2;
    const expDelay = transientExpDelay(
      attempt,
      BASE_CONFIG.transientBackoffBaseMs,
      BASE_CONFIG.transientBackoffCapMs,
    );

    // For each random seed in [0, 1), the produced delay must be in [0, expDelay).
    const seeds: number[] = [];
    for (let i = 0; i < PROPERTY_NUM_RUNS; i++) {
      seeds.push(i / PROPERTY_NUM_RUNS);
    }

    for (const seed of seeds) {
      vi.spyOn(Math, 'random').mockReturnValue(seed);
      const startedAt = Date.now();
      let calls = 0;
      let attemptAtFail: number | null = null;

      const promise = retryWithBackoff(
        async (n) => {
          calls++;
          if (calls === 1) {
            attemptAtFail = n;
            return {
              kind: 'http-error' as const,
              status: 503,
              bodyText: 'server',
              retryAfterSec: undefined,
            };
          }
          return { kind: 'success' as const, value: Date.now() - startedAt };
        },
        BASE_CONFIG,
      );

      // The sleep at attempt=1 uses expDelay = min(250*1, cap) = 250ms; full jitter
      // means actual delay ∈ [0, 250). Advance well past the upper bound.
      await vi.advanceTimersByTimeAsync(expDelay + 10);
      const elapsed = await promise;
      vi.restoreAllMocks();

      // delay = floor(seed * expDelayAt1) with expDelayAt1 = 250.
      const expDelayAt1 = transientExpDelay(
        1,
        BASE_CONFIG.transientBackoffBaseMs,
        BASE_CONFIG.transientBackoffCapMs,
      );
      const expectedDelay = Math.floor(seed * expDelayAt1);

      expect(attemptAtFail).toBe(1);
      // Elapsed equals the (mock-advanced) timer wait — should equal the jittered delay.
      // Use envelope assertion: 0 ≤ elapsed ≤ expDelayAt1.
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(expDelayAt1);
      // And matches the deterministic mock seed.
      expect(elapsed).toBe(expectedDelay);
    }
  });

  it('rate-limit Retry-After is honored as a strict floor (no early wake-up)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 25 }),
        fc.double({ min: 0, max: 0.9999, noNaN: true }),
        async (retryAfterSec, seed) => {
          vi.useFakeTimers();
          vi.spyOn(Math, 'random').mockReturnValue(seed);

          let attempt = 0;
          const promise = retryWithBackoff(
            async () => {
              attempt++;
              if (attempt === 1) {
                return {
                  kind: 'http-error' as const,
                  status: 429,
                  bodyText: 'rate',
                  retryAfterSec,
                };
              }
              return { kind: 'success' as const, value: attempt };
            },
            BASE_CONFIG,
          );

          const floorMs = Math.min(
            retryAfterSec * 1000,
            BASE_CONFIG.rateLimitBackoffCapMs,
          );

          // BEFORE the floor: must still be on attempt 1 (no early wake-up).
          await vi.advanceTimersByTimeAsync(floorMs - 1);
          expect(attempt).toBe(1);

          // AFTER floor + max jitter (25%): must have advanced to attempt 2.
          const jitterMax = Math.floor(floorMs * 0.25);
          await vi.advanceTimersByTimeAsync(jitterMax + 2);
          await promise;
          expect(attempt).toBe(2);

          vi.restoreAllMocks();
          vi.useRealTimers();
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('Property: retry budget honored exactly', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('with always-failing 5xx, exactly maxAttempts calls are made (initial + retries)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        async (maxAttempts) => {
          vi.useFakeTimers();
          // Make jitter deterministic so we know how long to advance.
          vi.spyOn(Math, 'random').mockReturnValue(0.9999);

          const config: RetryConfig = { ...BASE_CONFIG, maxAttempts };
          let calls = 0;
          let caught: unknown;
          const promise = retryWithBackoff(
            async () => {
              calls++;
              return {
                kind: 'http-error' as const,
                status: 503,
                bodyText: 'server',
                retryAfterSec: undefined,
              };
            },
            config,
          ).catch((err: unknown) => {
            caught = err;
          });

          // Sum of caps over (maxAttempts - 1) sleeps is an upper bound.
          const upper =
            (maxAttempts - 1) * config.transientBackoffCapMs + 100;
          await vi.advanceTimersByTimeAsync(upper);
          await promise;

          expect(calls).toBe(maxAttempts);
          expect(caught).toBeInstanceOf(Error);

          vi.restoreAllMocks();
          vi.useRealTimers();
        },
      ),
      { numRuns: 20 },
    );
  });

  it('4xx (non-429) errors are NOT retried — exactly 1 call', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 400, max: 499 }).filter((s) => s !== 429),
        async (status) => {
          let calls = 0;
          let caught: unknown;
          await retryWithBackoff(
            async () => {
              calls++;
              return {
                kind: 'http-error' as const,
                status,
                bodyText: 'client error',
                retryAfterSec: undefined,
              };
            },
            BASE_CONFIG,
          ).catch((err: unknown) => {
            caught = err;
          });
          expect(calls).toBe(1);
          expect(caught).toBeInstanceOf(Error);
        },
      ),
      { numRuns: PROPERTY_NUM_RUNS },
    );
  });

  it('5xx errors ARE retried (any status in [500, 599])', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 500, max: 599 }),
        async (status) => {
          vi.useFakeTimers();
          vi.spyOn(Math, 'random').mockReturnValue(0);
          let calls = 0;
          const promise = retryWithBackoff(
            async () => {
              calls++;
              if (calls === 1) {
                return {
                  kind: 'http-error' as const,
                  status,
                  bodyText: 'server',
                  retryAfterSec: undefined,
                };
              }
              return { kind: 'success' as const, value: 'ok' };
            },
            BASE_CONFIG,
          );
          await vi.advanceTimersByTimeAsync(BASE_CONFIG.transientBackoffCapMs + 10);
          const result = await promise;
          expect(result).toBe('ok');
          expect(calls).toBe(2);
          vi.restoreAllMocks();
          vi.useRealTimers();
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('Property: abort signal honored', () => {
  it('pre-aborted signal short-circuits with 0 fn calls', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    let caught: unknown;
    await retryWithBackoff(
      async () => {
        calls++;
        return { kind: 'success' as const, value: 'never' };
      },
      BASE_CONFIG,
      controller.signal,
    ).catch((err: unknown) => {
      caught = err;
    });
    expect(calls).toBe(0);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/abort/i);
  });

  it('abort during backoff sleep rejects with abort error and stops further attempts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let calls = 0;
    let caught: unknown;
    const promise = retryWithBackoff(
      async () => {
        calls++;
        return {
          kind: 'http-error' as const,
          status: 503,
          bodyText: 'server',
          retryAfterSec: undefined,
        };
      },
      BASE_CONFIG,
      controller.signal,
    ).catch((err: unknown) => {
      caught = err;
    });

    // Let first attempt happen, then enter the sleep.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // Abort mid-sleep.
    controller.abort();
    await vi.advanceTimersByTimeAsync(BASE_CONFIG.transientBackoffCapMs + 10);
    await promise;

    expect(calls).toBe(1); // No further attempts.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/abort/i);

    vi.useRealTimers();
  });
});

describe('Property: total wait bounded by sum of caps', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('total wall-clock wait ≤ Σ per-attempt expDelay caps (no infinite stacking)', async () => {
    vi.useFakeTimers();
    // Force max jitter so each sleep is at its envelope upper bound.
    // floor(0.9999 * expDelay) < expDelay, always.
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);

    const config: RetryConfig = { ...BASE_CONFIG, maxAttempts: 4 };
    const startedAt = Date.now();
    let caught: unknown;
    const promise = retryWithBackoff(
      async () => ({
        kind: 'http-error' as const,
        status: 503,
        bodyText: 'server',
        retryAfterSec: undefined,
      }),
      config,
    ).catch((err: unknown) => {
      caught = err;
    });

    // Upper bound = sum of per-attempt caps over (maxAttempts - 1) sleeps.
    let upperBound = 0;
    for (let n = 1; n <= config.maxAttempts - 1; n++) {
      upperBound += transientExpDelay(
        n,
        config.transientBackoffBaseMs,
        config.transientBackoffCapMs,
      );
    }
    // +slack for microtask scheduling.
    await vi.advanceTimersByTimeAsync(upperBound + 50);
    await promise;

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeLessThanOrEqual(upperBound + 50);
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('Property: transient network errors retried, others not', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const TRANSIENT_CODES = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
  ] as const;

  it('every known transient network code triggers a retry', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TRANSIENT_CODES),
        async (code) => {
          vi.useFakeTimers();
          vi.spyOn(Math, 'random').mockReturnValue(0);
          let calls = 0;
          const promise = retryWithBackoff(
            async () => {
              calls++;
              if (calls === 1) {
                const err = new Error('net') as Error & { code?: string };
                err.code = code;
                throw err;
              }
              return { kind: 'success' as const, value: 'recovered' };
            },
            BASE_CONFIG,
          );
          await vi.advanceTimersByTimeAsync(BASE_CONFIG.transientBackoffCapMs + 10);
          const result = await promise;
          expect(result).toBe('recovered');
          expect(calls).toBe(2);
          vi.restoreAllMocks();
          vi.useRealTimers();
        },
      ),
      { numRuns: 14 },
    );
  });

  it('transient code in cause chain triggers a retry (undici-style)', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    const promise = retryWithBackoff(
      async () => {
        calls++;
        if (calls === 1) {
          const inner = new Error('inner') as Error & { code?: string };
          inner.code = 'UND_ERR_SOCKET';
          throw Object.assign(new TypeError('fetch failed'), { cause: inner });
        }
        return { kind: 'success' as const, value: 'recovered' };
      },
      BASE_CONFIG,
    );
    await vi.advanceTimersByTimeAsync(BASE_CONFIG.transientBackoffCapMs + 10);
    const result = await promise;
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('non-transient error throws on first attempt (no retry)', async () => {
    let calls = 0;
    let caught: unknown;
    await retryWithBackoff(
      async () => {
        calls++;
        const err = new Error('weird') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      },
      BASE_CONFIG,
    ).catch((err: unknown) => {
      caught = err;
    });
    expect(calls).toBe(1);
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('Property: concurrent retry policies do not share state', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('two concurrent calls each observe their own attempt counters', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const callsA: number[] = [];
    const callsB: number[] = [];

    const promiseA = retryWithBackoff(
      async (n) => {
        callsA.push(n);
        if (n < 3) {
          return {
            kind: 'http-error' as const,
            status: 503,
            bodyText: 'a',
            retryAfterSec: undefined,
          };
        }
        return { kind: 'success' as const, value: 'A' };
      },
      BASE_CONFIG,
    );

    const promiseB = retryWithBackoff(
      async (n) => {
        callsB.push(n);
        if (n < 2) {
          return {
            kind: 'http-error' as const,
            status: 503,
            bodyText: 'b',
            retryAfterSec: undefined,
          };
        }
        return { kind: 'success' as const, value: 'B' };
      },
      BASE_CONFIG,
    );

    await vi.advanceTimersByTimeAsync(BASE_CONFIG.transientBackoffCapMs * 4);
    const [a, b] = await Promise.all([promiseA, promiseB]);

    expect(a).toBe('A');
    expect(b).toBe('B');
    expect(callsA).toEqual([1, 2, 3]);
    expect(callsB).toEqual([1, 2]);
  });
});

describe('Property: fetchWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pre-aborted external signal causes fetch to abort immediately', async () => {
    const controller = new AbortController();
    controller.abort();

    // Stub global fetch so no real network is touched. Reject with AbortError
    // when the signal is aborted at call time.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input, init) => {
        const sig = init?.signal;
        if (sig?.aborted === true) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        return new Response('ok');
      });

    await expect(
      fetchWithTimeout('http://example.invalid', {}, 10_000, controller.signal),
    ).rejects.toThrow(/abort/i);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Sanity: signal passed to fetch was already aborted.
    const callArgs = fetchSpy.mock.calls[0];
    const callInit = callArgs?.[1];
    expect(callInit?.signal?.aborted).toBe(true);
  });

  it('timeout aborts in-flight fetch after timeoutMs', async () => {
    vi.useFakeTimers();

    let abortObserved = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const sig = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        sig?.addEventListener(
          'abort',
          () => {
            abortObserved = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    });

    const promise = fetchWithTimeout('http://example.invalid', {}, 100);
    const tail = promise.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(150);
    const result = await tail;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).name).toBe('AbortError');
    expect(abortObserved).toBe(true);
  });
});
