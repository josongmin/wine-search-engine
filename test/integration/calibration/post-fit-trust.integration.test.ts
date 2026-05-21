/**
 * Post-fit trust verification (P0.1 — nightly auto-pipeline gate).
 *
 * The nightly workflow calls this test after `fit-resolver-calibration.ts`
 * has run. The contract: at least one row in `calibration_params` has a
 * fresh `fitted_at` (within `CALIBRATION_TTL_DAYS`) AND `loadIfFresh`
 * returns `trusted: true` for that row's query class.
 *
 * Without this check the nightly job could succeed structurally but
 * silently fail to flip the AdmissionGate trust flag.
 *
 * Skips when DATABASE_URL is not set so this lane runs only in CI / when
 * the operator explicitly points at a database with the fit applied.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PgCalibrationStore } from '../../../src/infrastructure/adapter/pg-calibration-store.js';
import { isQueryClass } from '../../../src/domain/shared/types/query-class.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const TTL_DAYS = Number.parseInt(process.env['CALIBRATION_TTL_DAYS'] ?? '14', 10);

describe.skipIf(!DATABASE_URL)('Calibration post-fit trust (P0.1)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('at least one calibration_params row has a fresh fitted_at', async () => {
    const { rows } = await pool.query<{ query_class: string; fitted_at: Date | null }>(
      `SELECT query_class, fitted_at
         FROM calibration_params
        WHERE fitted_at IS NOT NULL
          AND fitted_at >= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY fitted_at DESC
        LIMIT 1`,
      [TTL_DAYS],
    );
    expect(rows.length).toBeGreaterThan(0);
    // Should not be more than the TTL stale.
    const row = rows[0];
    expect(row).toBeDefined();
  });

  it('loadIfFresh flips to trusted=true for the freshest row', async () => {
    const store = new PgCalibrationStore(pool);
    const { rows } = await pool.query<{ query_class: string }>(
      `SELECT query_class
         FROM calibration_params
        WHERE fitted_at IS NOT NULL
        ORDER BY fitted_at DESC
        LIMIT 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const queryClass = rows[0]?.query_class;
    expect(queryClass).toBeDefined();
    if (queryClass === undefined || !isQueryClass(queryClass)) {
      throw new Error(`unexpected query_class: ${String(queryClass)}`);
    }
    const result = await store.loadIfFresh(queryClass, TTL_DAYS);
    expect(result.trusted).toBe(true);
  });
});
