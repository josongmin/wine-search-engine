import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgRefusalThresholdStore } from '../pg-refusal-threshold-store.js';

/**
 * The TTL cache is the only piece of state inside the store; everything
 * else is a thin SQL wrapper. These tests pin the cache contract:
 *  - within TTL: same Map reference, no new query
 *  - past TTL: refetched, new Map reference
 *  - failure: cache cleared so the next call retries the DB
 *
 * The pg Pool is stubbed inline — no real DB I/O.
 */

interface FakeRow {
  query_class: string;
  threshold: number;
  target_coverage: number;
  risk_at_coverage: number;
  sample_size: number;
  aurc: number;
  fitted_at: Date;
  dataset_hash: string;
}

function makeRow(queryClass: string, threshold: number): FakeRow {
  return {
    query_class: queryClass,
    threshold,
    target_coverage: 0.85,
    risk_at_coverage: 0.02,
    sample_size: 1000,
    aurc: 0.05,
    fitted_at: new Date('2026-05-21T00:00:00Z'),
    dataset_hash: 'abc',
  };
}

class FakePool {
  callCount = 0;
  constructor(private readonly responses: Array<{ rows: readonly FakeRow[] } | Error>) {}
  query(): Promise<{ rows: readonly FakeRow[] }> {
    const idx = this.callCount;
    this.callCount++;
    const next = this.responses[idx] ?? this.responses[this.responses.length - 1];
    if (next instanceof Error) return Promise.reject(next);
    if (next === undefined) return Promise.resolve({ rows: [] });
    return Promise.resolve(next);
  }
}

describe('PgRefusalThresholdStore TTL cache', () => {
  it('returns the cached lookup within TTL (no second DB call)', async () => {
    const pool = new FakePool([
      { rows: [makeRow('wine_name', 0.6), makeRow('general', 0.5)] },
    ]);
    let now = 1_000_000;
    const store = new PgRefusalThresholdStore(pool as unknown as Pool, {
      ttlSeconds: 60,
      now: () => now,
    });
    const first = await store.loadThresholds();
    expect(first.status).toBe('ok');

    now += 30 * 1000; // 30s elapsed, well within 60s TTL
    const second = await store.loadThresholds();
    expect(second).toBe(first); // same reference, served from cache
    expect(pool.callCount).toBe(1);
  });

  it('re-queries after TTL expires', async () => {
    const pool = new FakePool([
      { rows: [makeRow('wine_name', 0.6), makeRow('general', 0.5)] },
      { rows: [makeRow('wine_name', 0.65), makeRow('general', 0.55)] },
    ]);
    let now = 1_000_000;
    const store = new PgRefusalThresholdStore(pool as unknown as Pool, {
      ttlSeconds: 60,
      now: () => now,
    });
    const first = await store.loadThresholds();
    now += 61 * 1000; // past TTL
    const second = await store.loadThresholds();
    expect(pool.callCount).toBe(2);
    expect(second).not.toBe(first);
    if (second.status === 'ok') {
      expect(second.thresholds.get('wine_name')?.threshold).toBeCloseTo(0.65, 6);
    } else {
      throw new Error('expected ok status');
    }
  });

  it('does not cache unavailable status (DB error retries immediately)', async () => {
    const pool = new FakePool([
      new Error('connection refused'),
      { rows: [makeRow('wine_name', 0.6), makeRow('general', 0.5)] },
    ]);
    const store = new PgRefusalThresholdStore(pool as unknown as Pool, {
      ttlSeconds: 60,
    });
    const first = await store.loadThresholds();
    expect(first.status).toBe('unavailable');
    const second = await store.loadThresholds();
    expect(second.status).toBe('ok'); // would have stayed unavailable if cached
    expect(pool.callCount).toBe(2);
  });

  it('returns unavailable on empty table (edge: legitimate empty fit)', async () => {
    const pool = new FakePool([{ rows: [] }]);
    const store = new PgRefusalThresholdStore(pool as unknown as Pool, {
      ttlSeconds: 60,
    });
    const lookup = await store.loadThresholds();
    expect(lookup.status).toBe('unavailable');
  });

  it('skips rows that fail schema validation (adversarial DB drift)', async () => {
    const pool = new FakePool([
      {
        rows: [
          makeRow('wine_name', 0.6),
          // out-of-range threshold; Zod must reject
          { ...makeRow('producer', 1.5) } as FakeRow,
          makeRow('general', 0.5),
        ],
      },
    ]);
    const store = new PgRefusalThresholdStore(pool as unknown as Pool, {
      ttlSeconds: 60,
    });
    const lookup = await store.loadThresholds();
    expect(lookup.status).toBe('ok');
    if (lookup.status === 'ok') {
      expect(lookup.thresholds.has('wine_name')).toBe(true);
      expect(lookup.thresholds.has('producer')).toBe(false);
      expect(lookup.thresholds.has('general')).toBe(true);
    }
  });

  it('rejects non-positive ttlSeconds (adversarial config)', () => {
    expect(
      () =>
        new PgRefusalThresholdStore({} as unknown as Pool, { ttlSeconds: 0 }),
    ).toThrow();
    expect(
      () =>
        new PgRefusalThresholdStore({} as unknown as Pool, {
          ttlSeconds: Number.NaN,
        }),
    ).toThrow();
  });
});
