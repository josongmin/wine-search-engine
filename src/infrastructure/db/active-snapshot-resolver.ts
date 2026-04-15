/**
 * T-010/W2: single source of truth for "which snapshot is live right now".
 *
 * All read-path adapters that want to scope their queries to the active
 * snapshot MUST resolve the snapshot id through this helper. Never read
 * `runtime-state.json` directly — that file is the staging artifact; the DB
 * pointer is authoritative for in-flight requests.
 *
 * The pointer is cached per-pool with a short TTL so a burst of 100 concurrent
 * requests don't hammer `SELECT ... FROM active_search_snapshot`. The cache
 * is invalidated on publish (pointer write sets `last_promoted_at`) so stale
 * reads are bounded by TTL.
 */
import type { Pool } from 'pg';

export interface ActiveSnapshot {
  readonly activeSnapshotId: string;
  readonly previousSnapshotId: string | null;
  readonly contentHash: string;
  readonly promotedAt: Date;
}

/**
 * T-010/W2: thrown when `active_search_snapshot` table exists but no row has
 * been promoted yet. Distinct from a raw 42P01 sqlstate (table missing, dev
 * bootstrap) which adapters already handle in their existing catch blocks.
 */
export class NoActiveSnapshotPointerError extends Error {
  constructor() {
    super(
      'active_search_snapshot pointer row is missing. ' +
      'This means no publish has ever flipped the pointer. Run publish-search-snapshot to initialize.',
    );
    this.name = 'NoActiveSnapshotPointerError';
  }
}

/**
 * TTL for cached pointer reads. 2 seconds is short enough that a rollback
 * becomes visible within one "warm" request cycle, and long enough that a
 * burst of requests coalesces to a single pointer query.
 */
const POINTER_CACHE_TTL_MS = 2_000;

interface CacheEntry {
  readonly value: ActiveSnapshot;
  readonly expiresAt: number;
}

const cacheByPool = new WeakMap<Pool, CacheEntry>();

/**
 * Reads the active snapshot pointer, with short-TTL cache.
 *
 * Throws when the pointer row does not exist (never-published state). The
 * read path MUST NOT silently degrade — a missing pointer is the strongest
 * possible signal that the publish flow is broken.
 *
 * @param pool - the PG pool used by the caller adapter
 * @param opts.bypassCache - skip cache (used by readiness probes)
 */
export async function resolveActiveSnapshot(
  pool: Pool,
  opts: { readonly bypassCache?: boolean } = {},
): Promise<ActiveSnapshot> {
  const now = Date.now();
  if (!opts.bypassCache) {
    const cached = cacheByPool.get(pool);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
  }

  // 42P01 ("relation does not exist") flows back to the caller unchanged so
  // adapter-level `try { ... } catch (err) { if (sqlState === '42P01') return [] }`
  // logic continues to degrade gracefully in environments where the migration
  // has not yet been applied (tests, fresh dev DB bootstrap).
  const res = await pool.query<{
    active_snapshot_id: string;
    previous_snapshot_id: string | null;
    content_hash: string;
    promoted_at: Date;
  }>(
    `SELECT active_snapshot_id, previous_snapshot_id, content_hash, promoted_at
       FROM active_search_snapshot
      WHERE id = 1`,
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new NoActiveSnapshotPointerError();
  }

  const value: ActiveSnapshot = {
    activeSnapshotId: row.active_snapshot_id,
    previousSnapshotId: row.previous_snapshot_id,
    contentHash: row.content_hash,
    promotedAt: row.promoted_at,
  };

  if (!opts.bypassCache) {
    cacheByPool.set(pool, { value, expiresAt: now + POINTER_CACHE_TTL_MS });
  }

  return value;
}

/**
 * Explicitly drop cached pointer entry for a specific pool.
 *
 * Primary use case: **test seam**. Tests that drive the resolver directly
 * against a mock pool need to flush the cached entry between scenarios so
 * each scenario sees a fresh pointer read.
 *
 * Not needed in the production publish flow:
 *  - `promoteActiveSearchSnapshotPointer` creates its own dedicated pool,
 *    writes the DB row, and ends the pool — the WeakMap entry is released
 *    by GC.
 *  - Long-lived app pools (readiness probes, read-path adapters) refresh
 *    automatically via `POINTER_CACHE_TTL_MS` within ~2 seconds of a
 *    promote.
 *
 * If future ops tooling needs <2s propagation, call this explicitly from
 * the publish script with the app pool handle.
 */
export function invalidateActiveSnapshotCache(pool?: Pool): void {
  if (pool === undefined) {
    // WeakMap has no clear(); callers must pass a specific pool. Silent
    // no-op here lets ad-hoc debug calls compile without throwing.
    return;
  }
  cacheByPool.delete(pool);
}

/**
 * Exposed for test seams only. Production code should always go through
 * `resolveActiveSnapshot`.
 */
export const __testInternals = {
  POINTER_CACHE_TTL_MS,
  cacheByPool,
};
