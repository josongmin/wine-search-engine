/**
 * Pure helpers for the stale-snapshot Vespa cleanup CLI.
 *
 * I/O is intentionally split from logic so unit tests can exercise:
 *   - CLI flag parsing
 *   - protected-snapshot membership classifier (active vs stale)
 *   - page-by-page enumeration accounting
 *   - safety invariants (active_search_snapshot must have exactly 1 row)
 *
 * Wave 4 (multi-version corpus coexistence): `wine_entity` retains documents
 * from previous publish runs because the production publish path only
 * deletes docs that share the SAME `search_snapshot_id` as the new active
 * snapshot. Older snapshots never get reaped from the index, so the corpus
 * grows unboundedly across publishes. This module provides the off-band
 * GC tool that walks the index and removes any document whose
 * `search_snapshot_id` is not in the active (or operator-listed)
 * protected set.
 */

import { z } from 'zod';

/**
 * Vespa namespace + doctype the cleanup tool targets.
 *
 * Mirrors the constants in `scripts/etl/publish-search-snapshot.ts` so the
 * CLI talks to the same index as production publish (`wine` namespace,
 * `wine_entity` document type). Co-located here rather than imported so the
 * tool stays decoupled from the production wiring graph; if these ever
 * diverge a regression test catches it.
 */
export const VESPA_CLEANUP_NAMESPACE = 'wine';
export const VESPA_CLEANUP_DOC_TYPE = 'wine_entity';

/**
 * Default per-page hit cap for the YQL enumeration window.
 *
 * Matches `VESPA_SNAPSHOT_DOC_ID_QUERY_PAGE_SIZE` in publish-search-snapshot:
 * large enough to amortize HTTP latency, small enough that a single page
 * fits comfortably under Vespa's default per-query result limit. 400 also
 * lets the 17K-doc corpus complete in ~45 round trips.
 */
export const DEFAULT_PAGE_SIZE = 1_500;

/**
 * Default concurrency cap for parallel deletes.
 *
 * Each delete is a single Vespa Document v1 DELETE — cheap, idempotent.
 * 16 stays well below the undici `connections: 12` pool used elsewhere when
 * accounting for per-host HTTP/2 multiplexing; the dispatcher will queue
 * the overflow. Tuned to dispatch ~1K deletes per ~10s without saturating
 * the Vespa document plane.
 */
export const DEFAULT_DELETE_CONCURRENCY = 16;

/**
 * Progress log cadence. Print one line every N successful deletes so a
 * long-running cleanup is observable without flooding stdout.
 */
export const DEFAULT_PROGRESS_INTERVAL = 500;

/**
 * Upper bound on per-page hits we'll accept from Vespa before failing loud.
 *
 * Vespa is configured to cap result windows; we still cross-check to catch
 * a misconfigured cluster returning unbounded responses (could OOM the CLI).
 */
export const MAX_PAGE_SIZE = 100_000;

/**
 * Parsed CLI flags. All numeric flags are validated as positive integers
 * to avoid `--batch-size NaN` silently disabling concurrency.
 */
export interface CleanupCliFlags {
  readonly dryRun: boolean;
  readonly batchSize: number;
  readonly progressInterval: number;
  readonly pageSize: number;
  readonly limit?: number;
  readonly excludeSnapshots: readonly string[];
}

/**
 * Active-snapshot row read from `active_search_snapshot`. Mirrors the
 * shape used in `snapshot-health-reader.ts` and
 * `publish-runtime-substrates.ts`.
 */
export const ActiveSnapshotRowSchema = z
  .object({
    active_snapshot_id: z.string().min(1),
    previous_snapshot_id: z.string().min(1).nullable(),
  })
  .strict();
export type ActiveSnapshotRow = z.infer<typeof ActiveSnapshotRowSchema>;

/**
 * Per-doc envelope returned by the YQL enumeration step. We only care
 * about (entityId, snapshotId) for classification.
 */
export interface VespaDocEnvelope {
  readonly entityId: string;
  readonly snapshotId: string;
}

/**
 * Sentinel emitted by the enumerator for docs predating the
 * `search_snapshot_id` tagging contract. Classifier treats them as `skip`
 * — they are not eligible for stale cleanup until explicitly nuked.
 */
export const UNTAGGED_SNAPSHOT_SENTINEL = '__untagged-pre-snapshot-tagging__';

/**
 * Diff verdict for a single Vespa doc.
 *
 *  - `keep` — doc's snapshot is in the protected set (active or explicit
 *    operator override). Must NOT be deleted.
 *  - `stale` — doc's snapshot is outside the protected set. Eligible for
 *    deletion (subject to `--dry-run` / `--limit`).
 *  - `skip` — doc has no snapshot tag (legacy, pre-snapshot-tagging).
 *    Conservatively preserved; not eligible for this cleanup pass.
 */
export type DocVerdict = 'keep' | 'stale' | 'skip';

export interface ClassifiedDoc {
  readonly doc: VespaDocEnvelope;
  readonly verdict: DocVerdict;
}

/**
 * Classifier: given a doc and the protected snapshot set, return the
 * verdict. Pure — no Vespa, no PG, no clock.
 *
 * The protected set MUST include the active snapshot id and may include
 * additional snapshots passed via `--exclude-snapshot` (migration windows
 * where two active corpora coexist briefly).
 */
export function classifyDoc(
  doc: VespaDocEnvelope,
  protectedSnapshotIds: ReadonlySet<string>,
): ClassifiedDoc {
  if (doc.snapshotId === UNTAGGED_SNAPSHOT_SENTINEL) {
    return { doc, verdict: 'skip' };
  }
  if (protectedSnapshotIds.has(doc.snapshotId)) {
    return { doc, verdict: 'keep' };
  }
  return { doc, verdict: 'stale' };
}

/**
 * Reduces a batch of enumerated docs to the stale subset for deletion.
 * Order is preserved so progress logs reflect the enumeration order.
 */
export function selectStaleDocs(
  docs: readonly VespaDocEnvelope[],
  protectedSnapshotIds: ReadonlySet<string>,
): readonly VespaDocEnvelope[] {
  const stale: VespaDocEnvelope[] = [];
  for (const doc of docs) {
    const verdict = classifyDoc(doc, protectedSnapshotIds);
    if (verdict.verdict === 'stale') {
      stale.push(doc);
    }
  }
  return stale;
}

/**
 * Validate exactly-one-row invariant on the active snapshot pointer and
 * parse the row through Zod (rule 11: no `as DomainType` on PG output).
 *
 * Fails loud on:
 *   - 0 rows (publish never ran — refusing to delete every doc by default)
 *   - >1 row (singleton CHECK constraint violated — DB corruption)
 *   - shape mismatch (column renamed, type drift)
 */
export function parseActiveSnapshotRows(
  rows: readonly unknown[],
): ActiveSnapshotRow {
  if (rows.length === 0) {
    throw new Error(
      'active_search_snapshot is empty — refusing to run cleanup. ' +
        'A first publish must populate the pointer before stale-doc GC can be safe.',
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `active_search_snapshot has ${String(rows.length)} rows; expected exactly 1 (singleton CHECK id=1). ` +
        'DB integrity violated — investigate before running cleanup.',
    );
  }
  const parsed = ActiveSnapshotRowSchema.safeParse(rows[0]);
  if (!parsed.success) {
    throw new Error(
      `active_search_snapshot row shape invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Build the protected snapshot set: active id + any operator-supplied
 * `--exclude-snapshot` ids (deduplicated). `previous_snapshot_id` is NOT
 * automatically protected — operators must opt in explicitly via
 * `--exclude-snapshot`, because the cleanup tool is the mechanism for
 * reaping previous-snapshot leftovers in the first place.
 */
export function buildProtectedSet(
  activeSnapshotId: string,
  excludeSnapshots: readonly string[],
): ReadonlySet<string> {
  const set = new Set<string>([activeSnapshotId, ...excludeSnapshots]);
  return set;
}

/**
 * Parse CLI argv (without the `node tsx <script>` prefix). Returns a
 * frozen flags object. Throws on unknown flags or malformed numerics so
 * a typo (`--batchsize 8`) does not silently fall back to defaults.
 */
export function parseCleanupArgs(argv: readonly string[]): CleanupCliFlags {
  let dryRun = false;
  let batchSize = DEFAULT_DELETE_CONCURRENCY;
  let progressInterval = DEFAULT_PROGRESS_INTERVAL;
  let pageSize = DEFAULT_PAGE_SIZE;
  let limit: number | undefined;
  const excludeSnapshots: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--batch-size') {
      batchSize = readPositiveIntFlag(argv, i, '--batch-size');
      i += 1;
    } else if (arg === '--limit') {
      limit = readPositiveIntFlag(argv, i, '--limit');
      i += 1;
    } else if (arg === '--page-size') {
      pageSize = readPositiveIntFlag(argv, i, '--page-size');
      if (pageSize > MAX_PAGE_SIZE) {
        throw new Error(
          `--page-size ${String(pageSize)} exceeds MAX_PAGE_SIZE=${String(MAX_PAGE_SIZE)}`,
        );
      }
      i += 1;
    } else if (arg === '--progress-interval') {
      progressInterval = readPositiveIntFlag(argv, i, '--progress-interval');
      i += 1;
    } else if (arg === '--exclude-snapshot') {
      const value = argv[i + 1];
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        throw new Error('--exclude-snapshot requires a snapshot id argument');
      }
      excludeSnapshots.push(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      throw new Error('__HELP__');
    } else {
      throw new Error(`Unknown flag: ${String(arg)}`);
    }
  }

  return {
    dryRun,
    batchSize,
    progressInterval,
    pageSize,
    ...(limit !== undefined ? { limit } : {}),
    excludeSnapshots,
  };
}

function readPositiveIntFlag(
  argv: readonly string[],
  i: number,
  flagName: string,
): number {
  const raw = argv[i + 1];
  if (raw === undefined) {
    throw new Error(`${flagName} requires a numeric argument`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw) {
    throw new Error(
      `${flagName} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/**
 * Summary report shape emitted by the cleanup run (also used in dry-run
 * mode where `deleted === 0` and `wouldDelete > 0`).
 */
export interface CleanupReport {
  readonly enumerated: number;
  readonly stale: number;
  readonly deleted: number;
  readonly skippedByLimit: number;
  readonly failures: number;
  readonly dryRun: boolean;
  readonly activeSnapshotId: string;
  readonly protectedSnapshotIds: readonly string[];
}

/**
 * Decide how many docs to delete given the running deletion count, the
 * batch of stale docs, and the optional `--limit` cap. Returns the slice
 * of `staleBatch` that should actually be deleted and how many would be
 * skipped because of the cap.
 *
 * Pure so we can unit-test the off-by-one boundary at limit=0,1,N.
 */
export function applyDeleteLimit(
  staleBatch: readonly VespaDocEnvelope[],
  alreadyDeleted: number,
  limit: number | undefined,
): {
  readonly toDelete: readonly VespaDocEnvelope[];
  readonly skipped: number;
} {
  if (limit === undefined) {
    return { toDelete: staleBatch, skipped: 0 };
  }
  const remaining = Math.max(0, limit - alreadyDeleted);
  if (remaining >= staleBatch.length) {
    return { toDelete: staleBatch, skipped: 0 };
  }
  return {
    toDelete: staleBatch.slice(0, remaining),
    skipped: staleBatch.length - remaining,
  };
}
