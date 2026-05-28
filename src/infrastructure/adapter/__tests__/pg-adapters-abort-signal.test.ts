import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { PgThresholdStore } from '../pg-threshold-store.js';
import { PgCalibrationStore } from '../pg-calibration-store.js';
import { PgEntityRepository } from '../pg-entity-repository.js';
import { PgRefusalThresholdStore } from '../pg-refusal-threshold-store.js';
import { PgBlockingAdapter } from '../pg-blocking-adapter.js';
import { isAbortError } from '../../../domain/shared/cooperative-abort.js';
import type { QueryClass } from '../../../domain/shared/types/index.js';

/**
 * WSE-01 — cross-adapter AbortSignal propagation contract.
 *
 * Each PG adapter that now accepts an optional `signal` must, when given a
 * signal that is ALREADY aborted, refuse to spend a connection: no `pool.query`
 * and no `pool.connect`, and reject with an `AbortError`-named error. These are
 * pure unit tests — the pool and pooled client are stubbed, no real DB.
 *
 * The abort *mid-query* mechanics (destroy the dedicated client) are covered in
 * `src/infrastructure/db/__tests__/abortable-pg-query.test.ts`; here we assert
 * the wiring reaches each adapter's public method.
 */

interface SpyPool {
  pool: Pool;
  query: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}

function makeSpyPool(): SpyPool {
  const query = vi.fn(() => Promise.resolve({ rows: [] }));
  const connect = vi.fn(() =>
    Promise.resolve({
      query: vi.fn(() => Promise.resolve({ rows: [] })),
      release: vi.fn(),
    }),
  );
  const pool = { query, connect } as unknown as Pool;
  return { pool, query, connect };
}

function abortedSignal(): AbortSignal {
  const c = new AbortController();
  c.abort();
  return c.signal;
}

function expectNoConnectionSpent(spy: SpyPool): void {
  expect(spy.query).not.toHaveBeenCalled();
  expect(spy.connect).not.toHaveBeenCalled();
}

describe('WSE-01 PG adapters honor an already-aborted signal (pre-flight)', () => {
  it('PgThresholdStore.getProfile aborts before any query', async () => {
    const spy = makeSpyPool();
    const store = new PgThresholdStore(spy.pool);
    await expect(store.getProfile('p1', abortedSignal())).rejects.toSatisfy(isAbortError);
    expectNoConnectionSpent(spy);
  });

  it('PgThresholdStore.getDefault aborts before any query', async () => {
    const spy = makeSpyPool();
    const store = new PgThresholdStore(spy.pool);
    await expect(store.getDefault(abortedSignal())).rejects.toSatisfy(isAbortError);
    expectNoConnectionSpent(spy);
  });

  it('PgCalibrationStore.getCalibrationParams aborts before any query', async () => {
    const spy = makeSpyPool();
    const store = new PgCalibrationStore(spy.pool);
    await expect(
      store.getCalibrationParams('wine_name' as QueryClass, abortedSignal()),
    ).rejects.toSatisfy(isAbortError);
    expectNoConnectionSpent(spy);
  });

  it('PgRefusalThresholdStore.loadThresholds aborts before any query', async () => {
    const spy = makeSpyPool();
    const store = new PgRefusalThresholdStore(spy.pool, { ttlSeconds: 60 });
    await expect(store.loadThresholds(abortedSignal())).rejects.toSatisfy(isAbortError);
    expectNoConnectionSpent(spy);
  });
});

describe('WSE-01 PG adapters: no signal preserves the pooled query path', () => {
  it('PgThresholdStore.getProfile without a signal uses pool.query (no checkout)', async () => {
    const spy = makeSpyPool();
    const store = new PgThresholdStore(spy.pool);
    await store.getProfile('p1');
    expect(spy.query).toHaveBeenCalledTimes(1);
    expect(spy.connect).not.toHaveBeenCalled();
  });

  it('PgCalibrationStore.getCalibrationParams without a signal uses pool.query', async () => {
    const spy = makeSpyPool();
    const store = new PgCalibrationStore(spy.pool);
    await store.getCalibrationParams('wine_name' as QueryClass);
    expect(spy.query).toHaveBeenCalledTimes(1);
    expect(spy.connect).not.toHaveBeenCalled();
  });
});

describe('WSE-01 PgEntityRepository resolves the active snapshot before the abort check', () => {
  it('findById aborts at the data query without checking out a client', async () => {
    // resolveActiveSnapshot runs first (its own pooled query). The data query
    // — which carries the signal — must short-circuit on the aborted signal.
    const dataConnect = vi.fn();
    const query = vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            active_snapshot_id: 'search-snapshot:test',
            previous_snapshot_id: null,
            content_hash: 'hash',
            promoted_at: new Date(),
          },
        ],
      }),
    );
    const pool = { query, connect: dataConnect } as unknown as Pool;
    const repo = new PgEntityRepository(pool);

    await expect(
      // CanonicalEntityId is a branded string; cast through unknown for the stub.
      repo.findById('wine-x' as unknown as Parameters<typeof repo.findById>[0], abortedSignal()),
    ).rejects.toSatisfy(isAbortError);

    // The snapshot resolver used pool.query once; the data path never checked
    // out a dedicated client because the signal was already aborted.
    expect(dataConnect).not.toHaveBeenCalled();
  });
});

describe('WSE-01 PgBlockingAdapter does not count an abort as a query failure', () => {
  it('propagates AbortError from a mid-query abort without checkout when pre-aborted', async () => {
    const spy = makeSpyPool();
    // snapshotIdOverride bypasses resolveActiveSnapshot so the only query is the
    // blocking query, which carries the signal.
    const adapter = new PgBlockingAdapter(spy.pool, 'search-snapshot:test');
    await expect(
      adapter.block('opus one', 'opus one', 50, abortedSignal()),
    ).rejects.toSatisfy(isAbortError);
    expectNoConnectionSpent(spy);
  });
});
