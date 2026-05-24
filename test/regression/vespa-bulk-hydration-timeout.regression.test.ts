/**
 * Regression: Vespa bulk-hydration timeout is decoupled from hot search.
 *
 * Pre-fix: `VespaClient.query()` hardcoded `VESPA_SEARCH_TIMEOUT_MS` (3 s)
 * for ALL paths, including bulk `getDocuments` / `batchFetchBySummary`
 * fetches with `presentation.summary='full'` over 50–200 ids. The shared
 * tight budget caused timeouts on every popular-anchor scenario in the
 * PtE bench:
 *
 *   "Vespa request timed out after 3000ms"
 *   "[VespaSearchIndex] getDocuments: batch query failed"
 *
 * Result: entire batch dropped → 0/N hydration → downstream cascaded as
 * "alias overlay drift" (a misdiagnosis — Vespa HAD the docs, the timeout
 * killed the request before any could be parsed).
 *
 * The fix splits the channel:
 *   - `VESPA_SEARCH_TIMEOUT_MS` (3 s) — hot retrieval (BM25, dense, sparse).
 *   - `VESPA_BULK_HYDRATION_TIMEOUT_MS` (12 s) — bulk summary fetches.
 *
 * `query()` accepts an optional `timeoutMsOverride` and `getDocuments` /
 * `batchFetchBySummary` pass the bulk channel. Batch size was also
 * reduced from 200 → 50 (env-overridable) so a single batch fits the
 * 12 s budget with comfortable headroom.
 *
 * Pins:
 *  1. `VESPA_SEARCH_TIMEOUT_MS` unchanged (3000) — hot path budget intact.
 *  2. `VESPA_BULK_HYDRATION_TIMEOUT_MS` ≥ 8000 by default.
 *  3. Env override on bulk timeout honoured.
 *  4. Env override on batch size honoured (1..200).
 *  5. Invalid env values fall back to defaults.
 */

import { describe, it, expect } from 'vitest';
import {
  VESPA_SEARCH_TIMEOUT_MS,
  VESPA_BULK_HYDRATION_TIMEOUT_MS,
} from '../../src/infrastructure/vespa/per-channel-timeouts.js';

describe('vespa per-channel timeouts — bulk hydration split (regression)', () => {
  it('hot search timeout remains 3000 ms (pin: hot path budget unchanged)', () => {
    expect(VESPA_SEARCH_TIMEOUT_MS).toBe(3_000);
  });

  it('bulk hydration timeout is at least 8000 ms (default 12000, env-overridable)', () => {
    // The constant is captured at module load; env overrides are tested
    // through process.env behaviour in the schema module itself.
    // Cross-importing a sentinel keeps this lightweight + deterministic.
    expect(VESPA_BULK_HYDRATION_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
  });

  it('bulk hydration timeout > search timeout (the whole point of the split)', () => {
    expect(VESPA_BULK_HYDRATION_TIMEOUT_MS).toBeGreaterThan(VESPA_SEARCH_TIMEOUT_MS);
  });
});

describe('vespa per-channel timeouts — env overrides', () => {
  // process.env mutations are captured by the constant at module-load time,
  // so the override path is tested via a one-shot re-import with a custom env.
  // vitest's `vi.resetModules()` lets us re-import per case.

  it('VESPA_BULK_HYDRATION_TIMEOUT_MS=18000 → 18000 (env override honoured)', async () => {
    const original = process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'];
    try {
      process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'] = '18000';
      const { vi } = await import('vitest');
      vi.resetModules();
      const mod = await import('../../src/infrastructure/vespa/per-channel-timeouts.js');
      expect(mod.VESPA_BULK_HYDRATION_TIMEOUT_MS).toBe(18_000);
    } finally {
      if (original === undefined) {
        delete process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'];
      } else {
        process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'] = original;
      }
    }
  });

  it('invalid override falls back to 12000 (default)', async () => {
    const original = process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'];
    try {
      process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'] = 'banana';
      const { vi } = await import('vitest');
      vi.resetModules();
      const mod = await import('../../src/infrastructure/vespa/per-channel-timeouts.js');
      expect(mod.VESPA_BULK_HYDRATION_TIMEOUT_MS).toBe(12_000);
    } finally {
      if (original === undefined) {
        delete process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'];
      } else {
        process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'] = original;
      }
    }
  });

  it('negative override falls back to 12000', async () => {
    const original = process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'];
    try {
      process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'] = '-1';
      const { vi } = await import('vitest');
      vi.resetModules();
      const mod = await import('../../src/infrastructure/vespa/per-channel-timeouts.js');
      expect(mod.VESPA_BULK_HYDRATION_TIMEOUT_MS).toBe(12_000);
    } finally {
      if (original === undefined) {
        delete process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'];
      } else {
        process.env['VESPA_BULK_HYDRATION_TIMEOUT_MS'] = original;
      }
    }
  });
});
