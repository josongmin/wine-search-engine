/**
 * Regression: pg-watchlist-store — corrupt JSONB in findById must not throw.
 *
 * If a single watchlist row has corrupt trigger_conditions (bad JSONB from
 * a migration, ETL bug, or manual edit), rowToWatchlistEntry() throws.
 * Before the fix, that exception escaped findById() and produced a permanent
 * 500 on GET /watchlists/:id for any user whose row was corrupted.
 *
 * After the fix, findById and findByIdForUpdate catch the parse error,
 * emit a structured warning, and return null — matching the "not found"
 * contract rather than crashing the request.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { PgWatchlistStore } from '../pg-watchlist-store.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeValidRow(): Record<string, unknown> {
  return {
    watchlist_id: 'wl-001',
    user_id: 'user-abc',
    entity_id: 'entity-xyz',
    trigger_conditions: [{ type: 'new_vintage', minVintage: 2020 }],
    callback_url: 'https://example.com/webhook',
    created_at: new Date('2026-01-01T00:00:00Z'),
    expires_at: null,
  };
}

function makeCorruptRow(): Record<string, unknown> {
  return {
    ...makeValidRow(),
    watchlist_id: 'wl-corrupt',
    // trigger_conditions is not an array → parseWatchlistTriggers returns null → throws
    trigger_conditions: { not: 'an array' },
  };
}

function makePool(rows: unknown[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as Pool;
}

// ── findById ─────────────────────────────────────────────────────────────────

describe('PgWatchlistStore.findById — corrupt JSONB isolation', () => {
  it('returns a valid entry when the row is well-formed', async () => {
    const pool = makePool([makeValidRow()]);
    const store = new PgWatchlistStore(pool);

    const entry = await store.findById('wl-001');

    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('wl-001');
    expect(entry!.userId).toBe('user-abc');
    expect(entry!.triggerConditions).toHaveLength(1);
  });

  it('returns null (not throws) when the row has corrupt trigger_conditions', async () => {
    const pool = makePool([makeCorruptRow()]);
    const store = new PgWatchlistStore(pool);

    // Before the fix this threw; after the fix it must return null.
    await expect(store.findById('wl-corrupt')).resolves.toBeNull();
  });

  it('returns null when no row matches the id', async () => {
    const pool = makePool([]);
    const store = new PgWatchlistStore(pool);

    await expect(store.findById('wl-missing')).resolves.toBeNull();
  });

  it('re-throws unexpected executor errors (network failure, etc.)', async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    } as unknown as Pool;
    const store = new PgWatchlistStore(pool);

    await expect(store.findById('wl-001')).rejects.toThrow('DB connection lost');
  });
});

// ── findByIdForUpdate ─────────────────────────────────────────────────────────

describe('PgWatchlistStore.findByIdForUpdate — corrupt JSONB isolation', () => {
  it('returns a valid entry when the row is well-formed', async () => {
    const pool = makePool([makeValidRow()]);
    const store = new PgWatchlistStore(pool);

    const entry = await store.findByIdForUpdate('wl-001');

    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('wl-001');
  });

  it('returns null (not throws) when the row has corrupt trigger_conditions', async () => {
    const pool = makePool([makeCorruptRow()]);
    const store = new PgWatchlistStore(pool);

    await expect(store.findByIdForUpdate('wl-corrupt')).resolves.toBeNull();
  });

  it('returns null when no row matches', async () => {
    const pool = makePool([]);
    const store = new PgWatchlistStore(pool);

    await expect(store.findByIdForUpdate('wl-missing')).resolves.toBeNull();
  });
});

// ── findByUserId already safe via mapRowsSafe — regression guard ──────────────

describe('PgWatchlistStore.findByUserId — corrupt row is pre-existing safe path', () => {
  it('skips corrupt rows and returns only valid entries', async () => {
    const pool = makePool([makeValidRow(), makeCorruptRow()]);
    const store = new PgWatchlistStore(pool);

    const entries = await store.findByUserId('user-abc');

    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('wl-001');
  });
});
