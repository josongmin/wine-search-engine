/**
 * Bronze Vivino data connector — HTTP fetch resilience regression.
 *
 * Maturity bump 2 → 3 (etl.bronze-data-connector):
 *   - Dedicated regression suite for retry/backoff + freshness metadata.
 *   - Retry policy is configurable via `maxRetries`.
 *   - Backoff is exponential with full-jitter, bounded by a documented cap.
 *   - Snapshot artifacts carry a freshness timestamp (ISO 8601).
 *
 * Implementation under test:
 *   tools/bronze-vivino-data-connector/fetch-vivino-snapshots.ts
 *     - fetchVivinoSnapshot(opts) — HTTP fetcher with injected clock + RNG.
 *     - BRONZE_FETCH_MAX_RETRIES_DEFAULT / BRONZE_FETCH_BASE_BACKOFF_MS /
 *       BRONZE_FETCH_MAX_BACKOFF_MS — named constants (CLAUDE.md rule 15).
 *     - BRONZE_FETCHED_AT_FORMAT — freshness metadata format string.
 *
 * Append-only. Mocks `fetch`; NEVER hits the real Vivino API.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BRONZE_FETCH_BASE_BACKOFF_MS,
  BRONZE_FETCH_MAX_BACKOFF_MS,
  BRONZE_FETCH_MAX_RETRIES_DEFAULT,
  BRONZE_FETCHED_AT_FORMAT,
  fetchVivinoSnapshot,
  type BronzeFetchClock,
  type BronzeFetchResult,
} from '../../tools/bronze-vivino-data-connector/fetch-vivino-snapshots.js';

const ENDPOINT = 'https://example.invalid/vivino/snapshot';
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

type BodyShape = { records: Array<{ external_id: string }> };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fixedClock(fixedNowIso: string, fixedSeed: number): BronzeFetchClock {
  const sleeps: number[] = [];
  const clock: BronzeFetchClock = {
    nowIso: () => fixedNowIso,
    random: () => fixedSeed,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  return { ...clock, sleeps } as BronzeFetchClock & { sleeps: number[] };
}

function withSleeps(clock: BronzeFetchClock): number[] {
  return (clock as BronzeFetchClock & { sleeps: number[] }).sleeps;
}

describe('bronze-data-connector: named constants and freshness format', () => {
  it('exposes documented retry/backoff constants with sane domain values', () => {
    expect(BRONZE_FETCH_MAX_RETRIES_DEFAULT).toBe(3);
    expect(BRONZE_FETCH_BASE_BACKOFF_MS).toBe(1000);
    expect(BRONZE_FETCH_MAX_BACKOFF_MS).toBe(30000);
  });

  it('declares freshness metadata format as ISO 8601', () => {
    expect(BRONZE_FETCHED_AT_FORMAT).toBe('iso-8601');
  });
});

describe('bronze-data-connector: successful fetch', () => {
  it('records snapshot + ISO 8601 fetchedAt metadata on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { records: [{ external_id: '3961941' }] } satisfies BodyShape),
    );
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);

    const result: BronzeFetchResult<BodyShape> = await fetchVivinoSnapshot<BodyShape>({
      url: ENDPOINT,
      fetch: fetchMock,
      clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.snapshot.records).toEqual([{ external_id: '3961941' }]);
    expect(result.fetchedAt).toBe('2026-05-21T10:00:00.000Z');
    expect(ISO_8601_REGEX.test(result.fetchedAt)).toBe(true);
    expect(result.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(withSleeps(clock)).toEqual([]);
  });
});

describe('bronze-data-connector: retry on transient errors', () => {
  it('retries once on 503 then succeeds on 200 (2 fetch calls)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }))
      .mockResolvedValueOnce(jsonResponse(200, { records: [] } satisfies BodyShape));
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);

    const result: BronzeFetchResult<BodyShape> = await fetchVivinoSnapshot<BodyShape>({
      url: ENDPOINT,
      fetch: fetchMock,
      clock,
    });

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(withSleeps(clock).length).toBe(1);
  });

  it('exhausts default retry budget on 3 consecutive 503 (exactly 3 calls)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);

    const result: BronzeFetchResult<BodyShape> = await fetchVivinoSnapshot<BodyShape>({
      url: ENDPOINT,
      fetch: fetchMock,
      clock,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.attempts).toBe(BRONZE_FETCH_MAX_RETRIES_DEFAULT);
    expect(result.error.kind).toBe('http-error');
    if (result.error.kind === 'http-error') {
      expect(result.error.status).toBe(503);
    }
    expect(fetchMock).toHaveBeenCalledTimes(BRONZE_FETCH_MAX_RETRIES_DEFAULT);
    // Sleeps happen BETWEEN attempts: maxRetries=3 → 2 sleeps.
    expect(withSleeps(clock).length).toBe(BRONZE_FETCH_MAX_RETRIES_DEFAULT - 1);
  });

  it('retries on TypeError (undici network error) then surfaces final failure', async () => {
    const networkError = new TypeError('fetch failed');
    const fetchMock = vi.fn().mockRejectedValue(networkError);
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);

    const result: BronzeFetchResult<BodyShape> = await fetchVivinoSnapshot<BodyShape>({
      url: ENDPOINT,
      fetch: fetchMock,
      clock,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('network-error');
    expect(fetchMock).toHaveBeenCalledTimes(BRONZE_FETCH_MAX_RETRIES_DEFAULT);
  });

  it('does NOT retry on 4xx (401) — single fetch, error returned', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);

    const result: BronzeFetchResult<BodyShape> = await fetchVivinoSnapshot<BodyShape>({
      url: ENDPOINT,
      fetch: fetchMock,
      clock,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('http-error');
    if (result.error.kind === 'http-error') {
      expect(result.error.status).toBe(401);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(withSleeps(clock)).toEqual([]);
  });
});

describe('bronze-data-connector: backoff delays', () => {
  it('sleep durations follow exponential full-jitter envelope bounded by cap', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));
    // Seed=1.0 would round to exp, so use 0.5 → delay = floor(0.5 * expDelay).
    const seed = 0.5;
    const clock = fixedClock('2026-05-21T10:00:00.000Z', seed);

    await fetchVivinoSnapshot<BodyShape>({
      url: ENDPOINT,
      fetch: fetchMock,
      clock,
      maxRetries: 4,
    });

    const sleeps = withSleeps(clock);
    expect(sleeps.length).toBe(3); // 4 attempts → 3 between-sleeps

    // expDelay(n) = min(BASE * 2^(n-1), CAP)
    // delay(n)    = floor(seed * expDelay(n))
    for (let n = 1; n <= sleeps.length; n++) {
      const expDelay = Math.min(
        BRONZE_FETCH_BASE_BACKOFF_MS * 2 ** (n - 1),
        BRONZE_FETCH_MAX_BACKOFF_MS,
      );
      const expected = Math.floor(seed * expDelay);
      const slept = sleeps[n - 1];
      if (slept === undefined) throw new Error('missing sleep sample');
      expect(slept).toBeGreaterThanOrEqual(0);
      expect(slept).toBeLessThan(expDelay);
      expect(slept).toBeLessThanOrEqual(BRONZE_FETCH_MAX_BACKOFF_MS);
      expect(slept).toBe(expected);
    }
    // Monotonic non-decreasing (until cap).
    for (let i = 1; i < sleeps.length; i++) {
      const prev = sleeps[i - 1];
      const cur = sleeps[i];
      if (prev === undefined || cur === undefined) throw new Error('missing sample');
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });
});

describe('bronze-data-connector: configurable retry budget', () => {
  it('honors {maxRetries: 5} exactly — 5 fetch calls, 4 sleeps', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);

    const result: BronzeFetchResult<BodyShape> = await fetchVivinoSnapshot<BodyShape>({
      url: ENDPOINT,
      fetch: fetchMock,
      clock,
      maxRetries: 5,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.attempts).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(withSleeps(clock).length).toBe(4);
  });

  it('rejects maxRetries < 1 (must make at least one attempt)', async () => {
    const fetchMock = vi.fn();
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
    await expect(
      fetchVivinoSnapshot<BodyShape>({
        url: ENDPOINT,
        fetch: fetchMock,
        clock,
        maxRetries: 0,
      }),
    ).rejects.toThrow(/maxRetries/u);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bronze-data-connector: adjacent regressions (determinism, empty, concurrency)', () => {
  it('seeded jitter is deterministic across runs with same seed + injected clock', async () => {
    const buildClock = (): BronzeFetchClock =>
      fixedClock('2026-05-21T10:00:00.000Z', 0.25);

    const fetchMockA = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { records: [] } satisfies BodyShape));
    const fetchMockB = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { records: [] } satisfies BodyShape));

    const clockA = buildClock();
    const clockB = buildClock();

    const [a, b] = await Promise.all([
      fetchVivinoSnapshot<BodyShape>({ url: ENDPOINT, fetch: fetchMockA, clock: clockA }),
      fetchVivinoSnapshot<BodyShape>({ url: ENDPOINT, fetch: fetchMockB, clock: clockB }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(withSleeps(clockA)).toEqual(withSleeps(clockB));
    expect(withSleeps(clockA).length).toBe(2);
  });

  it('handles empty record list (0 records) gracefully with freshness metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { records: [] } satisfies BodyShape));
    const clock = fixedClock('2026-05-21T10:00:00.000Z', 0.5);

    const result: BronzeFetchResult<BodyShape> = await fetchVivinoSnapshot<BodyShape>({
      url: ENDPOINT,
      fetch: fetchMock,
      clock,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.snapshot.records).toEqual([]);
    expect(ISO_8601_REGEX.test(result.fetchedAt)).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('concurrent fetches do not share retry / sleep state', async () => {
    // Two parallel fetchers, each with independent clocks + fetch mocks.
    // Fetcher A: 503 → 200 (1 retry).
    // Fetcher B: 200 immediately (0 retries).
    const fetchA = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(jsonResponse(200, { records: [{ external_id: 'A' }] }));
    const fetchB = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { records: [{ external_id: 'B' }] }));

    const clockA = fixedClock('2026-05-21T10:00:00.000Z', 0.5);
    const clockB = fixedClock('2026-05-21T10:00:01.000Z', 0.5);

    const [a, b] = await Promise.all([
      fetchVivinoSnapshot<BodyShape>({ url: ENDPOINT, fetch: fetchA, clock: clockA }),
      fetchVivinoSnapshot<BodyShape>({ url: ENDPOINT, fetch: fetchB, clock: clockB }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.attempts).toBe(2);
    expect(b.attempts).toBe(1);
    expect(a.fetchedAt).toBe('2026-05-21T10:00:00.000Z');
    expect(b.fetchedAt).toBe('2026-05-21T10:00:01.000Z');
    expect(withSleeps(clockA).length).toBe(1);
    expect(withSleeps(clockB).length).toBe(0);
    expect(a.snapshot.records).toEqual([{ external_id: 'A' }]);
    expect(b.snapshot.records).toEqual([{ external_id: 'B' }]);
  });
});
