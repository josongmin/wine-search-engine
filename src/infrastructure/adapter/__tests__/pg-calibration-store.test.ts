import { describe, expect, it } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { PgCalibrationStore } from '../pg-calibration-store.js';
import type { CalibrationParams } from '../../../domain/resolver/port/calibration-store.port.js';

/**
 * Unit tests for PgCalibrationStore — focus on the P0.1 freshness gate
 * (`loadIfFresh`). Boundary cases:
 *   - within TTL (trusted)
 *   - exactly at TTL boundary (trusted, inclusive)
 *   - just outside TTL (stale)
 *   - missing row (untrusted)
 *   - row with NULL fitted_at (never_fitted)
 *   - non-finite ttlDays (rejected)
 */

interface CalibrationRow extends QueryResultRow {
  query_class: string;
  method: string;
  params: unknown;
  ece: number;
  trained_at: Date;
  fitted_at: Date | null;
  dataset_hash: string | null;
  sample_size: number | null;
}

function fakePool(rows: readonly CalibrationRow[]): Pool {
  return {
    query: async (): Promise<QueryResult<CalibrationRow>> => ({
      rows: [...rows],
      rowCount: rows.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    }),
  } as unknown as Pool;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-05-21T12:00:00Z');

function makeRow(fittedAtIso: string | null, override: Partial<CalibrationRow> = {}): CalibrationRow {
  return {
    query_class: 'short_entity',
    method: 'platt',
    params: { a: 1, b: 0 },
    ece: 0.04,
    trained_at: fittedAtIso !== null ? new Date(fittedAtIso) : NOW,
    fitted_at: fittedAtIso !== null ? new Date(fittedAtIso) : null,
    dataset_hash: 'abc123',
    sample_size: 500,
    ...override,
  };
}

describe('PgCalibrationStore.loadIfFresh — TTL boundary cases', () => {
  it('returns trusted=true when fitted_at is well within TTL', async () => {
    // fitted 3 days ago, ttl = 14 days → trusted
    const fittedAt = new Date(NOW.getTime() - 3 * MS_PER_DAY).toISOString();
    const store = new PgCalibrationStore(fakePool([makeRow(fittedAt)]));
    const out = await store.loadIfFresh('short_entity', 14, NOW);
    expect(out.trusted).toBe(true);
    if (out.trusted) {
      expect(out.params.queryClass).toBe('short_entity');
      expect(out.params.fittedAt?.toISOString()).toBe(fittedAt);
    }
  });

  it('returns trusted=true at exactly the TTL boundary (inclusive)', async () => {
    // fitted exactly 14 days ago, ttl = 14 → trusted (age == ttl, not >)
    const fittedAt = new Date(NOW.getTime() - 14 * MS_PER_DAY).toISOString();
    const store = new PgCalibrationStore(fakePool([makeRow(fittedAt)]));
    const out = await store.loadIfFresh('short_entity', 14, NOW);
    expect(out.trusted).toBe(true);
  });

  it('returns trusted=false (stale) when fitted_at is just past the TTL boundary', async () => {
    // fitted 14 days + 1ms ago → stale
    const fittedAt = new Date(NOW.getTime() - 14 * MS_PER_DAY - 1).toISOString();
    const store = new PgCalibrationStore(fakePool([makeRow(fittedAt)]));
    const out = await store.loadIfFresh('short_entity', 14, NOW);
    expect(out.trusted).toBe(false);
    if (!out.trusted) {
      expect(out.reason).toBe('stale');
      expect(out.params).not.toBeNull();
      expect(out.params?.queryClass).toBe('short_entity');
    }
  });

  it('returns trusted=false (stale) when fitted_at is much older than TTL', async () => {
    const fittedAt = new Date(NOW.getTime() - 365 * MS_PER_DAY).toISOString();
    const store = new PgCalibrationStore(fakePool([makeRow(fittedAt)]));
    const out = await store.loadIfFresh('short_entity', 14, NOW);
    expect(out.trusted).toBe(false);
    if (!out.trusted) expect(out.reason).toBe('stale');
  });

  it('returns trusted=false (never_fitted) when fitted_at is NULL (legacy row)', async () => {
    // trained_at populated, fitted_at NULL — exactly the legacy-row scenario.
    const store = new PgCalibrationStore(fakePool([makeRow(null)]));
    const out = await store.loadIfFresh('short_entity', 14, NOW);
    expect(out.trusted).toBe(false);
    if (!out.trusted) {
      expect(out.reason).toBe('never_fitted');
      // params still surfaced so the calibrator can apply the stored
      // model for display, just not for refusal.
      expect(out.params).not.toBeNull();
    }
  });

  it('returns trusted=false (missing) when no row exists', async () => {
    const store = new PgCalibrationStore(fakePool([]));
    const out = await store.loadIfFresh('short_entity', 14, NOW);
    expect(out.trusted).toBe(false);
    if (!out.trusted) {
      expect(out.reason).toBe('missing');
      expect(out.params).toBeNull();
    }
  });

  it('rejects non-finite ttlDays (adversarial input, schema rule)', async () => {
    const store = new PgCalibrationStore(fakePool([]));
    await expect(store.loadIfFresh('short_entity', Number.NaN, NOW)).rejects.toThrow(
      /positive finite/u,
    );
    await expect(store.loadIfFresh('short_entity', 0, NOW)).rejects.toThrow(/positive finite/u);
    await expect(store.loadIfFresh('short_entity', -1, NOW)).rejects.toThrow(/positive finite/u);
  });

  it('returns trusted=false on JSONB shape corruption (validator rejection)', async () => {
    // params is not a Record<string, number> — corrupted row.
    const corruptedRow = makeRow(NOW.toISOString(), { params: { a: 'not-a-number' } });
    const store = new PgCalibrationStore(fakePool([corruptedRow]));
    const out = await store.loadIfFresh('short_entity', 14, NOW);
    expect(out.trusted).toBe(false);
    if (!out.trusted) expect(out.reason).toBe('missing');
  });

  it('respects an injected `now` so tests are clock-independent', async () => {
    // Row fitted at 2026-01-01; with now=2026-01-08, ttl=14 → trusted.
    const fittedAt = new Date('2026-01-01T00:00:00Z');
    const store = new PgCalibrationStore(fakePool([makeRow(fittedAt.toISOString())]));
    const out = await store.loadIfFresh('short_entity', 14, new Date('2026-01-08T00:00:00Z'));
    expect(out.trusted).toBe(true);
  });
});

describe('PgCalibrationStore — round-trip of CalibrationParams metadata', () => {
  it('surfaces fittedAt/datasetHash/sampleSize on getCalibrationParams', async () => {
    const fittedAt = new Date('2026-05-15T00:00:00Z');
    const store = new PgCalibrationStore(
      fakePool([
        makeRow(fittedAt.toISOString(), {
          dataset_hash: 'sha256:deadbeef',
          sample_size: 1234,
        }),
      ]),
    );
    const params = await store.getCalibrationParams('short_entity');
    expect(params).not.toBeNull();
    const p = params as CalibrationParams;
    expect(p.fittedAt?.toISOString()).toBe(fittedAt.toISOString());
    expect(p.datasetHash).toBe('sha256:deadbeef');
    expect(p.sampleSize).toBe(1234);
  });

  it('omits optional fields when DB columns are NULL', async () => {
    const store = new PgCalibrationStore(
      fakePool([makeRow(null, { dataset_hash: null, sample_size: null })]),
    );
    const params = await store.getCalibrationParams('short_entity');
    expect(params).not.toBeNull();
    const p = params as CalibrationParams;
    expect(p.fittedAt).toBeUndefined();
    expect(p.datasetHash).toBeUndefined();
    expect(p.sampleSize).toBeUndefined();
  });
});
