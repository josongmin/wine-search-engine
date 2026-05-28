/**
 * Unit test: snapshot-health-reader in isolation. Covers the 5 paths the
 * /ready handler must trust:
 *   1. happy path — pointer + cross-snapshot count + positive pointer_age
 *   2. pointer table missing row (first publish) → undefined
 *   3. SQL throw on pointer query → undefined (best-effort)
 *   4. SQL throw on count query → undefined (best-effort)
 *   5. count query returns non-numeric string → undefined (defensive parse)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSnapshotHealthReader,
  SNAPSHOT_HEALTH_QUERY_TIMEOUT_MS,
} from '../snapshot-health-reader.js';

interface MockPool {
  connect: ReturnType<typeof vi.fn>;
  client: {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

function makePool(responses: readonly ({ rows: unknown[] } | Error)[]): MockPool {
  let i = 0;
  const client = {
    query: vi.fn(async (query: string) => {
      if (query === 'BEGIN' || query === 'ROLLBACK' || query === 'COMMIT') {
        return { rows: [] };
      }
      if (query.startsWith('SET LOCAL statement_timeout')) {
        return { rows: [] };
      }
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r ?? { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    connect: vi.fn(async () => client),
    client,
  };
}

describe('createSnapshotHealthReader', () => {
  it('returns pointer + stale count + non-negative pointer_age on happy path', async () => {
    const pool = makePool([
      { rows: [{
        active_snapshot_id: 'a',
        previous_snapshot_id: 'b',
        promoted_at: new Date(Date.now() - 3600 * 1000),
      }]},
      { rows: [{ c: '42' }] },
    ]);
     
    const reader = createSnapshotHealthReader(pool as never);
    const result = await reader();
    expect(result).toEqual({
      active_snapshot_id: 'a',
      previous_snapshot_id: 'b',
      stale_row_count: 42,
      pointer_age_seconds: expect.any(Number),
    });
    expect(result?.pointer_age_seconds).toBeGreaterThanOrEqual(3599);
    expect(result?.pointer_age_seconds).toBeLessThanOrEqual(3601);
  });

  it('returns undefined when the pointer row is absent (first publish)', async () => {
    const pool = makePool([{ rows: [] }]);
     
    const reader = createSnapshotHealthReader(pool as never);
    const result = await reader();
    expect(result).toBeUndefined();
  });

  it('returns undefined when the pointer query throws', async () => {
    const pool = makePool([new Error('pg connection refused')]);
     
    const reader = createSnapshotHealthReader(pool as never);
    const result = await reader();
    expect(result).toBeUndefined();
  });

  it('returns undefined when the stale-count query throws', async () => {
    const pool = makePool([
      { rows: [{
        active_snapshot_id: 'a',
        previous_snapshot_id: 'b',
        promoted_at: new Date(),
      }]},
      new Error('query timeout'),
    ]);
     
    const reader = createSnapshotHealthReader(pool as never);
    const result = await reader();
    expect(result).toBeUndefined();
  });

  it('returns undefined when the stale-count comes back non-finite', async () => {
    const pool = makePool([
      { rows: [{
        active_snapshot_id: 'a',
        previous_snapshot_id: 'b',
        promoted_at: new Date(),
      }]},
      { rows: [{ c: 'not-a-number' }] },
    ]);
     
    const reader = createSnapshotHealthReader(pool as never);
    const result = await reader();
    expect(result).toBeUndefined();
  });

  it('clamps pointer_age_seconds to zero for clock-skew (promoted_at in the future)', async () => {
    const pool = makePool([
      { rows: [{
        active_snapshot_id: 'a',
        previous_snapshot_id: 'b',
        promoted_at: new Date(Date.now() + 60_000), // future — clock skew
      }]},
      { rows: [{ c: '0' }] },
    ]);
     
    const reader = createSnapshotHealthReader(pool as never);
    const result = await reader();
    expect(result?.pointer_age_seconds).toBe(0);
  });

  it('applies bounded query timeouts to both snapshot_health PG reads', async () => {
    const pool = makePool([
      { rows: [{
        active_snapshot_id: 'a',
        previous_snapshot_id: 'b',
        promoted_at: new Date(),
      }]},
      { rows: [{ c: '1' }] },
    ]);

    const reader = createSnapshotHealthReader(pool as never);
    await reader();

    expect(pool.client.query).toHaveBeenCalledWith('BEGIN');
    expect(pool.client.query).toHaveBeenCalledWith(
      `SET LOCAL statement_timeout = '${SNAPSHOT_HEALTH_QUERY_TIMEOUT_MS}ms'`,
    );
  });
});
