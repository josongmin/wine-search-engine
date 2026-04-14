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
import { createSnapshotHealthReader } from '../snapshot-health-reader.js';

interface MockPool {
  query: ReturnType<typeof vi.fn>;
}

function makePool(responses: readonly ({ rows: unknown[] } | Error)[]): MockPool {
  let i = 0;
  return {
    query: vi.fn(async () => {
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r ?? { rows: [] };
    }),
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
});
