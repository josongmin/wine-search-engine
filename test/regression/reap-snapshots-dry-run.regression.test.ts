/**
 * Invariant: `reap-snapshots.ts` defaults to dry-run and never DELETEs without
 * `--force`. Also enforces grace-period and "previous_snapshot_id is null"
 * safety checks. These guards are the only thing standing between an operator
 * typo and permanent rollback-history loss.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it, vi } from 'vitest';
import { reapSnapshots } from '../../scripts/ops/reap-snapshots.js';

const PROMOTED_RECENTLY = new Date();
const PROMOTED_LONG_AGO = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago

function makePool(
  pointerRow: { active_snapshot_id: string; previous_snapshot_id: string | null; promoted_at: Date } | undefined,
  rowCountPerTable: number,
): {
  pool: Parameters<typeof reapSnapshots>[1];
  queryLog: { sql: string; params: unknown[] }[];
} {
  const queryLog: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queryLog.push({ sql, params: params ?? [] });
      if (/FROM active_search_snapshot/.test(sql)) {
        return { rows: pointerRow ? [pointerRow] : [], rowCount: pointerRow ? 1 : 0 };
      }
      if (/SELECT COUNT\(\*\)/.test(sql)) {
        return { rows: [{ c: String(rowCountPerTable) }], rowCount: 1 };
      }
      if (/^DELETE FROM/.test(sql)) {
        return { rows: [], rowCount: rowCountPerTable };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
  };
   
  return { pool: pool as unknown as Parameters<typeof reapSnapshots>[1], queryLog };
}

describe('reap-snapshots safety', () => {
  it('dry-run issues no DELETE even when candidate rows exist', async () => {
    const { pool, queryLog } = makePool(
      { active_snapshot_id: 'a', previous_snapshot_id: 'b', promoted_at: PROMOTED_LONG_AGO },
      42,
    );
    const summary = await reapSnapshots({ force: false, gracePeriodHours: 24 }, pool);
    expect(summary.performed).toBe('dry-run');
    expect(summary.reports.every((r) => r.candidateRowCount === 42)).toBe(true);
    expect(summary.reports.every((r) => r.deletedRowCount === 0)).toBe(true);
    const deleteIssued = queryLog.some((q) => q.sql.startsWith('DELETE'));
    expect(deleteIssued).toBe(false);
  });

  it('skips when previous_snapshot_id is NULL (first publish)', async () => {
    const { pool } = makePool(
      { active_snapshot_id: 'a', previous_snapshot_id: null, promoted_at: PROMOTED_LONG_AGO },
      99,
    );
    const summary = await reapSnapshots({ force: true, gracePeriodHours: 24 }, pool);
    expect(summary.performed).toBe('skipped');
    expect(summary.skipReason).toMatch(/previous_snapshot_id is NULL/);
  });

  it('skips when pointer promoted within the grace period', async () => {
    const { pool } = makePool(
      { active_snapshot_id: 'a', previous_snapshot_id: 'b', promoted_at: PROMOTED_RECENTLY },
      99,
    );
    const summary = await reapSnapshots({ force: true, gracePeriodHours: 24 }, pool);
    expect(summary.performed).toBe('skipped');
    expect(summary.skipReason).toMatch(/grace period/);
  });

  it('skips when active_search_snapshot is empty', async () => {
    const { pool } = makePool(undefined, 0);
    const summary = await reapSnapshots({ force: true, gracePeriodHours: 24 }, pool);
    expect(summary.performed).toBe('skipped');
    expect(summary.skipReason).toMatch(/active_search_snapshot is empty/);
  });

  it('force + passed grace period + non-null previous DELETEs all 3 tables', async () => {
    const { pool, queryLog } = makePool(
      { active_snapshot_id: 'a', previous_snapshot_id: 'b', promoted_at: PROMOTED_LONG_AGO },
      7,
    );
    const summary = await reapSnapshots({ force: true, gracePeriodHours: 24 }, pool);
    expect(summary.performed).toBe('force');
    expect(summary.reports.map((r) => r.table)).toEqual([
      'entities',
      'aliases',
      'ambiguity_registry',
    ]);
    expect(summary.reports.every((r) => r.deletedRowCount === 7)).toBe(true);
    const deletes = queryLog.filter((q) => q.sql.trim().startsWith('DELETE FROM'));
    expect(deletes.length).toBe(3);
  });
});
