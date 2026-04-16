import type { Pool } from 'pg';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'snapshot-health-reader' });

/** Shape surfaced on GET /ready response body as `snapshot_health`. */
interface SnapshotHealth {
  readonly active_snapshot_id: string;
  readonly previous_snapshot_id: string | null;
  readonly stale_row_count: number;
  readonly pointer_age_seconds: number;
}

/**
 * Runtime plane composite-PK migration (016) observability probe: collect the
 * cross-snapshot row count waiting for the reaper + pointer age, emit as part
 * of /ready.
 *
 * This is best-effort — any failure (PG down, pointer table missing, snapshot
 * row absent) returns `undefined`. The /ready handler omits the block instead
 * of propagating a 503. /ready's job is to report readiness, not to fail
 * closed on an auxiliary observability gauge.
 */
export function createSnapshotHealthReader(pool: Pool): () => Promise<SnapshotHealth | undefined> {
  return async () => {
    try {
      const { rows: pointerRows } = await pool.query<{
        active_snapshot_id: string;
        previous_snapshot_id: string | null;
        promoted_at: Date;
      }>(
        `SELECT active_snapshot_id, previous_snapshot_id, promoted_at
         FROM active_search_snapshot
         WHERE id = 1`,
      );
      const pointer = pointerRows[0];
      if (pointer === undefined) return undefined;

      const protectedIds = [pointer.active_snapshot_id, pointer.previous_snapshot_id].filter(
        (id): id is string => id !== null,
      );

      const { rows: staleRows } = await pool.query<{ c: string }>(
        `SELECT (
           (SELECT COUNT(*) FROM entities WHERE search_snapshot_id <> ALL($1::text[]))
           + (SELECT COUNT(*) FROM aliases WHERE search_snapshot_id <> ALL($1::text[]))
           + (SELECT COUNT(*) FROM ambiguity_registry WHERE search_snapshot_id <> ALL($1::text[]))
         )::text AS c`,
        [protectedIds],
      );
      const staleRowCount = Number(staleRows[0]?.c ?? '0');
      if (!Number.isFinite(staleRowCount)) return undefined;

      const pointerAgeSeconds = Math.max(
        0,
        Math.floor((Date.now() - pointer.promoted_at.getTime()) / 1000),
      );

      return {
        active_snapshot_id: pointer.active_snapshot_id,
        previous_snapshot_id: pointer.previous_snapshot_id,
        stale_row_count: staleRowCount,
        pointer_age_seconds: pointerAgeSeconds,
      };
    } catch (err: unknown) {
      log.debug({ err }, 'snapshot-health read failed; returning undefined');
      return undefined;
    }
  };
}
