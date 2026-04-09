import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  retryWithBackoff,
  parseRetryAfterHeader,
  isTransientNetworkError,
  type RetryConfig,
} from '../retry-with-backoff.js';

const BASE_CONFIG: RetryConfig = {
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
  label: 'Test',
};

describe('retryWithBackoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns value on first-attempt success', async () => {
    const result = await retryWithBackoff(
      async () => ({ kind: 'success', value: 'ok' }),
      BASE_CONFIG,
    );
    expect(result).toBe('ok');
  });

  it('retries on transient 5xx and succeeds on next attempt', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const resultPromise = retryWithBackoff(
      async () => {
        attempt++;
        if (attempt === 1) {
          return { kind: 'http-error', status: 503, bodyText: 'server error', retryAfterSec: undefined };
        }
        return { kind: 'success', value: 'recovered' };
      },
      BASE_CONFIG,
    );
    // Advance past the transient backoff (max 2s at attempt 1)
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await resultPromise;
    expect(result).toBe('recovered');
    expect(attempt).toBe(2);
  });

  it('retries on 429 with exponential backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    let attempt = 0;
    const resultPromise = retryWithBackoff(
      async () => {
        attempt++;
        if (attempt < 3) {
          return { kind: 'http-error', status: 429, bodyText: 'rate limited', retryAfterSec: undefined };
        }
        return { kind: 'success', value: 'ok' };
      },
      BASE_CONFIG,
    );
    // Attempt 1 fires immediately, then waits ~2s (base * 2^0 * jitter)
    expect(attempt).toBe(1);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(attempt).toBe(2);
    // Attempt 2 waits ~4s (base * 2^1 * jitter)
    await vi.advanceTimersByTimeAsync(4_100);
    expect(attempt).toBe(3);
    const result = await resultPromise;
    expect(result).toBe('ok');
    vi.restoreAllMocks();
  });

  it('respects Retry-After header on 429', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let attempt = 0;
    const resultPromise = retryWithBackoff(
      async () => {
        attempt++;
        if (attempt === 1) {
          return { kind: 'http-error', status: 429, bodyText: 'rate limited', retryAfterSec: 10 };
        }
        return { kind: 'success', value: 'ok' };
      },
      BASE_CONFIG,
    );
    // Should NOT resolve before 10s
    await vi.advanceTimersByTimeAsync(9_000);
    expect(attempt).toBe(1);
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await resultPromise;
    expect(result).toBe('ok');
    expect(attempt).toBe(2);
    vi.restoreAllMocks();
  });

  it('throws after exhausting all retries on persistent 429', async () => {
    vi.useFakeTimers();
    let caughtError: unknown;
    const resultPromise = retryWithBackoff(
      async () => ({ kind: 'http-error' as const, status: 429, bodyText: 'rate limited', retryAfterSec: undefined }),
      BASE_CONFIG,
    ).catch((err: unknown) => { caughtError = err; });
    // Advance enough for all retries
    await vi.advanceTimersByTimeAsync(40_000);
    await resultPromise;
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/429/);
  });

  it('throws non-retryable HTTP errors immediately (e.g. 400)', async () => {
    await expect(
      retryWithBackoff(
        async () => ({ kind: 'http-error', status: 400, bodyText: 'bad request', retryAfterSec: undefined }),
        BASE_CONFIG,
      ),
    ).rejects.toThrow(/400/);
  });

  it('retries on transient network errors', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const resultPromise = retryWithBackoff(
      async () => {
        attempt++;
        if (attempt === 1) {
          const err = new Error('connect failed');
          (err as Record<string, unknown>)['code'] = 'ECONNRESET';
          throw err;
        }
        return { kind: 'success', value: 'recovered' };
      },
      BASE_CONFIG,
    );
    await vi.advanceTimersByTimeAsync(2_100);
    const result = await resultPromise;
    expect(result).toBe('recovered');
  });

  it('propagates AbortError immediately without retry', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    await expect(
      retryWithBackoff(
        async () => { throw abortErr; },
        BASE_CONFIG,
      ),
    ).rejects.toThrow(/aborted/);
  });

  it('does not retry wrapped AbortError (name="AbortError")', async () => {
    let attempt = 0;
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    await expect(
      retryWithBackoff(
        async () => {
          attempt++;
          throw abortErr;
        },
        BASE_CONFIG,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(attempt).toBe(1);
  });

  it('aborts mid-wait when signal fires', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const resultPromise = retryWithBackoff(
      async () => ({ kind: 'http-error' as const, status: 429, bodyText: 'rate limited', retryAfterSec: undefined }),
      BASE_CONFIG,
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await expect(resultPromise).rejects.toThrow(/abort/i);
  });

  it('throws immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      retryWithBackoff(
        async () => ({ kind: 'success', value: 'should not reach' }),
        BASE_CONFIG,
        controller.signal,
      ),
    ).rejects.toThrow(/abort/i);
  });

  it('does not retry non-transient network errors', async () => {
    let attempt = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempt++;
          throw new Error('some unknown error');
        },
        BASE_CONFIG,
      ),
    ).rejects.toThrow('some unknown error');
    expect(attempt).toBe(1);
  });
});

describe('parseRetryAfterHeader', () => {
  it('parses numeric Retry-After header', () => {
    const response = new Response('', { headers: { 'Retry-After': '10' } });
    expect(parseRetryAfterHeader(response)).toBe(10);
  });

  it('returns undefined for missing header', () => {
    const response = new Response('', {});
    expect(parseRetryAfterHeader(response)).toBeUndefined();
  });

  it('returns undefined for non-numeric non-date header', () => {
    const response = new Response('', { headers: { 'Retry-After': 'not-a-number' } });
    expect(parseRetryAfterHeader(response)).toBeUndefined();
  });

  it('parses HTTP-date Retry-After header', () => {
    const futureDate = new Date(Date.now() + 30_000);
    const response = new Response('', {
      headers: { 'Retry-After': futureDate.toUTCString() },
    });
    const result = parseRetryAfterHeader(response);
    expect(result).toBeDefined();
    // Should be roughly 30s (allow 5s tolerance for test execution time)
    expect(result!).toBeGreaterThan(25);
    expect(result!).toBeLessThanOrEqual(31);
  });

  it('returns undefined for past HTTP-date', () => {
    const pastDate = new Date(Date.now() - 10_000);
    const response = new Response('', {
      headers: { 'Retry-After': pastDate.toUTCString() },
    });
    expect(parseRetryAfterHeader(response)).toBeUndefined();
  });

  it('rejects partial-parse values like "123abc"', () => {
    const response = new Response('', { headers: { 'Retry-After': '123abc' } });
    expect(parseRetryAfterHeader(response)).toBeUndefined();
  });

  it('rejects fractional seconds "10.5" (RFC 7231 delta-seconds is 1*DIGIT only)', () => {
    const response = new Response('', { headers: { 'Retry-After': '10.5' } });
    expect(parseRetryAfterHeader(response)).toBeUndefined();
  });

  it('returns undefined for zero or negative values', () => {
    expect(parseRetryAfterHeader(new Response('', { headers: { 'Retry-After': '0' } }))).toBeUndefined();
    expect(parseRetryAfterHeader(new Response('', { headers: { 'Retry-After': '-1' } }))).toBeUndefined();
  });
});

describe('isTransientNetworkError', () => {
  it('detects ECONNRESET', () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('detects ETIMEDOUT', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('detects transient code in cause', () => {
    const err = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('inner'), { code: 'ECONNRESET' }),
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns false for non-transient errors', () => {
    expect(isTransientNetworkError(new Error('random'))).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });

  it('returns false for non-transient error codes', () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    expect(isTransientNetworkError(err)).toBe(false);
  });
});
