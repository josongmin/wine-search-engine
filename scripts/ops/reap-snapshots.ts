#!/usr/bin/env tsx
/**
 * Reap stale runtime-plane snapshot rows.
 *
 * Deletes rows from entities/aliases/ambiguity_registry whose
 * search_snapshot_id is neither the active nor the previous snapshot (as
 * recorded in active_search_snapshot).
 *
 * Default: --dry-run. Destructive execution requires --force.
 *
 * Refuses to act when:
 *  - active_search_snapshot.previous_snapshot_id IS NULL (first publish —
 *    nothing safe to reap yet)
 *  - Time since pointer.promoted_at < grace period (operator has not yet
 *    given the active snapshot time to prove itself)
 *
 * Usage:
 *   pnpm exec tsx scripts/ops/reap-snapshots.ts                    # dry-run
 *   pnpm exec tsx scripts/ops/reap-snapshots.ts --force            # destructive
 *   pnpm exec tsx scripts/ops/reap-snapshots.ts --grace-period-hours 48 --force
 */

import 'dotenv/config';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { bootstrapLogger } from '../../src/domain/shared/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'reap-snapshots' });

interface Args {
  readonly force: boolean;
  readonly gracePeriodHours: number;
}

const DEFAULT_GRACE_PERIOD_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

function parseArgs(argv: readonly string[]): Args {
  let force = false;
  let gracePeriodHours = DEFAULT_GRACE_PERIOD_HOURS;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
    } else if (arg === '--grace-period-hours') {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--grace-period-hours expects a non-negative number, got ${String(argv[i + 1])}`);
      }
      gracePeriodHours = n;
      i += 1;
    } else if (arg === '--dry-run') {
      force = false;
    }
  }
  return { force, gracePeriodHours };
}

interface TableReport {
  readonly table: string;
  readonly candidateRowCount: number;
  readonly deletedRowCount: number;
}

const REAPABLE_TABLES = ['entities', 'aliases', 'ambiguity_registry'] as const;

interface ReapSummary {
  readonly performed: 'dry-run' | 'force' | 'skipped';
  readonly skipReason?: string | undefined;
  readonly activeSnapshotId: string | null;
  readonly previousSnapshotId: string | null;
  readonly reports: readonly TableReport[];
}

export async function reapSnapshots(args: Args, pool: import('pg').Pool): Promise<ReapSummary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: pointerRows } = await client.query<{
      active_snapshot_id: string;
      previous_snapshot_id: string | null;
      promoted_at: Date;
    }>(
      `SELECT active_snapshot_id, previous_snapshot_id, promoted_at
       FROM active_search_snapshot
       WHERE id = 1`,
    );
    const pointer = pointerRows[0];
    if (pointer === undefined) {
      await client.query('ROLLBACK');
      return {
        performed: 'skipped',
        skipReason: 'active_search_snapshot is empty',
        activeSnapshotId: null,
        previousSnapshotId: null,
        reports: [],
      };
    }
    if (pointer.previous_snapshot_id === null) {
      await client.query('ROLLBACK');
      return {
        performed: 'skipped',
        skipReason: 'previous_snapshot_id is NULL (first publish); nothing safe to reap',
        activeSnapshotId: pointer.active_snapshot_id,
        previousSnapshotId: null,
        reports: [],
      };
    }
    const gracePeriodMs = args.gracePeriodHours * MS_PER_HOUR;
    const promotedAtMs = pointer.promoted_at.getTime();
    if (Date.now() - promotedAtMs < gracePeriodMs) {
      await client.query('ROLLBACK');
      return {
        performed: 'skipped',
        skipReason: `pointer promoted within grace period (${args.gracePeriodHours}h)`,
        activeSnapshotId: pointer.active_snapshot_id,
        previousSnapshotId: pointer.previous_snapshot_id,
        reports: [],
      };
    }

    const protectedIds = [pointer.active_snapshot_id, pointer.previous_snapshot_id];
    const reports: TableReport[] = [];

    for (const table of REAPABLE_TABLES) {
       
      const candidate = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ${table}
         WHERE search_snapshot_id <> ALL($1::text[])`,
        [protectedIds],
      );
      const candidateRowCount = Number(candidate.rows[0]?.c ?? '0');
      let deletedRowCount = 0;
      if (args.force && candidateRowCount > 0) {
        const del = await client.query(
          `DELETE FROM ${table}
           WHERE search_snapshot_id <> ALL($1::text[])`,
          [protectedIds],
        );
        deletedRowCount = del.rowCount ?? 0;
      }
      reports.push({ table, candidateRowCount, deletedRowCount });
    }

    if (args.force) {
      await client.query('COMMIT');
      return {
        performed: 'force',
        activeSnapshotId: pointer.active_snapshot_id,
        previousSnapshotId: pointer.previous_snapshot_id,
        reports,
      };
    }
    await client.query('ROLLBACK');
    return {
      performed: 'dry-run',
      activeSnapshotId: pointer.active_snapshot_id,
      previousSnapshotId: pointer.previous_snapshot_id,
      reports,
    };
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error('Postgres configuration is required to reap snapshots');
  }
  const pool = createPgPool(config.pg);
  try {
    const summary = await reapSnapshots(args, pool);
    log.warn({ summary }, 'reap-snapshots complete');
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
     
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
