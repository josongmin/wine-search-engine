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
import { runAbortablePgQuery } from './abortable-pg-query.js';

interface ActiveSnapshot {
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
export const ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS = 2_000;

interface CachedActiveSnapshotValue {
  readonly kind: 'hit';
  readonly value: ActiveSnapshot;
  readonly expiresAt: number;
}

interface CachedMissingTableValue {
  readonly kind: 'missing_table';
  readonly expiresAt: number;
}

type CacheEntry = CachedActiveSnapshotValue | CachedMissingTableValue;

const cacheByPool = new WeakMap<Pool, CacheEntry>();

const BOOTSTRAP_ACTIVE_SNAPSHOT_SUBSTRATE_ENV = 'WINE_ENGINE_BOOTSTRAP_ACTIVE_SNAPSHOT_SUBSTRATE';

interface ActiveSnapshotResolverOptions {
  readonly bypassCache?: boolean;
  readonly queryTimeoutMs?: number;
}

function createTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Explicit bootstrap seam for fresh dev/test environments.
 *
 * Production/default read paths must not silently treat missing snapshot
 * substrate as a steady state. The only allowed opt-in is NODE_ENV !=
 * production, or an explicit bootstrap env flag when production bootstrap is
 * intentionally being performed.
 */
export function isActiveSnapshotSubstrateBootstrapAllowed(): boolean {
  return process.env['NODE_ENV'] !== 'production'
    || process.env[BOOTSTRAP_ACTIVE_SNAPSHOT_SUBSTRATE_ENV] === '1';
}

function buildMissingTableError(): Error & { readonly code: '42P01' } {
  const err = new Error('relation "active_search_snapshot" does not exist') as Error & {
    code: '42P01';
  };
  err.code = '42P01';
  return err;
}

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
  opts: ActiveSnapshotResolverOptions = {},
): Promise<ActiveSnapshot> {
  const now = Date.now();
  if (!opts.bypassCache) {
    const cached = cacheByPool.get(pool);
    if (cached !== undefined && cached.expiresAt > now) {
      if (cached.kind === 'hit') {
        return cached.value;
      }
      throw buildMissingTableError();
    }
  }

  let res: { rows: Array<{
    active_snapshot_id: string;
    previous_snapshot_id: string | null;
    content_hash: string;
    promoted_at: Date;
  }> };

  const timeout = opts.queryTimeoutMs;
  const timed = timeout === undefined ? undefined : createTimeoutSignal(timeout);
  try {
    if (timed === undefined || typeof (pool as { connect?: unknown }).connect !== 'function') {
      res = await pool.query<{
        active_snapshot_id: string;
        previous_snapshot_id: string | null;
        content_hash: string;
        promoted_at: Date;
      }>(
        `SELECT active_snapshot_id, previous_snapshot_id, content_hash, promoted_at
         FROM active_search_snapshot
        WHERE id = 1`,
      );
    } else {
      res = await runAbortablePgQuery<{
        active_snapshot_id: string;
        previous_snapshot_id: string | null;
        content_hash: string;
        promoted_at: Date;
      }>(
        pool,
        timed.signal,
        `SELECT active_snapshot_id, previous_snapshot_id, content_hash, promoted_at
         FROM active_search_snapshot
         WHERE id = 1`,
      );
    }
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err
      ? (err as { code?: string }).code
      : undefined;
    if (code === '42P01') {
      if (!opts.bypassCache) {
        cacheByPool.set(pool, { kind: 'missing_table', expiresAt: now + ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS });
      }
      throw err;
    }
    throw err;
  } finally {
    timed?.clear();
  }
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
    cacheByPool.set(pool, { kind: 'hit', value, expiresAt: now + ACTIVE_SNAPSHOT_POINTER_CACHE_TTL_MS });
  }

  return value;
}
