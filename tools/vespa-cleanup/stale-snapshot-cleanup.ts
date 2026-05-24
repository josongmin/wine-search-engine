#!/usr/bin/env tsx
/**
 * Wave 4 stub — stale-snapshot Vespa cleanup CLI.
 *
 * Walks the `wine_entity` index and deletes documents whose
 * `search_snapshot_id` is NOT in the currently-active set (read from
 * `active_search_snapshot` in wine-engine-pg). Intended to be run
 * off-band; the production publish pipeline only deletes stale docs that
 * share the new active snapshot id, so prior snapshots accumulate
 * indefinitely.
 *
 * Required env (mTLS to Vespa Cloud):
 *   VESPA_URL              — e.g. https://bf75....aws-us-east-1c.dev.z.vespa-app.cloud
 *   VESPA_CERT_PATH        — local PEM cert path
 *   VESPA_KEY_PATH         — local PEM key path
 *   DATABASE_URL           — wine-engine-pg DSN (has `active_search_snapshot`)
 *
 * Usage (dry-run first, then real):
 *   pnpm tsx tools/vespa-cleanup/stale-snapshot-cleanup.ts --dry-run
 *   pnpm tsx tools/vespa-cleanup/stale-snapshot-cleanup.ts --batch-size 16
 *   pnpm tsx tools/vespa-cleanup/stale-snapshot-cleanup.ts --limit 1000 --exclude-snapshot 79e799ca01bb9a9a
 *
 * Flags:
 *   --dry-run                 Report only, don't delete
 *   --batch-size N            Delete concurrency cap (default 16)
 *   --page-size N             YQL enumeration window (default 400, max 10000)
 *   --limit N                 Cap total deletes (safety brake)
 *   --exclude-snapshot <id>   Additional snapshot id to keep (repeatable)
 *   --progress-interval N     Print progress every N deletes (default 500)
 */

import { Pool } from 'pg';
import { VespaClient } from '../../src/infrastructure/vespa/vespa-client.js';
import {
  applyDeleteLimit,
  buildProtectedSet,
  type CleanupCliFlags,
  type CleanupReport,
  DEFAULT_DELETE_CONCURRENCY,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PROGRESS_INTERVAL,
  MAX_PAGE_SIZE,
  parseActiveSnapshotRows,
  parseCleanupArgs,
  selectStaleDocs,
  VESPA_CLEANUP_DOC_TYPE,
  VESPA_CLEANUP_NAMESPACE,
  type VespaDocEnvelope,
} from './cleanup-core.js';

/**
 * Minimal Vespa surface the cleanup driver needs. Defined here (and
 * implemented over `VespaClient`) so the test can substitute a fake
 * without spinning up mTLS / undici / the real client.
 */
export interface VespaCleanupTransport {
  enumerateDocs(args: {
    readonly pageSize: number;
    readonly offset: number;
  }): Promise<{
    readonly docs: readonly VespaDocEnvelope[];
    readonly totalCount: number;
  }>;
  deleteDoc(entityId: string): Promise<void>;
}

/**
 * Minimal PG surface needed: a single SELECT against
 * `active_search_snapshot`. Matches the shape we mock in tests so the
 * unit test does not need a real Pool.
 */
export interface PgCleanupTransport {
  readActiveSnapshotRows(): Promise<readonly unknown[]>;
}

/**
 * Minimum docs the corpus must contain before we trust the enumeration.
 *
 * The cleanup tool fails loud on 0 enumerated docs because that signals
 * either (a) an empty / wrong cluster (operator pointed at the wrong
 * VESPA_URL) or (b) a YQL grammar regression dropping every hit. Either
 * way, refusing to "successfully" do nothing is the safer default.
 */
const MIN_EXPECTED_DOCS = 1;

/**
 * YQL enumeration query. We do NOT filter by snapshot — we need all live
 * docs so we can compare each `search_snapshot_id` against the active
 * set. `order by entity_id asc` gives a stable pagination order so a
 * mid-run failure can be resumed by restarting (concurrent writes are
 * not expected in this off-band tool).
 */
function buildEnumerationYql(pageSize: number, offset: number): string {
  return (
    `select entity_id, search_snapshot_id from sources ${VESPA_CLEANUP_DOC_TYPE} ` +
    `where true order by entity_id asc limit ${String(pageSize)} offset ${String(offset)};`
  );
}

/**
 * Construct the production VespaCleanupTransport over a real VespaClient.
 * Pulled out of `main()` so unit tests can construct the driver without
 * touching env / mTLS / undici.
 */
export function createVespaCleanupTransport(
  vespa: Pick<VespaClient, 'query' | 'delete'>,
): VespaCleanupTransport {
  return {
    async enumerateDocs({ pageSize, offset }) {
      const response = await vespa.query(
        buildEnumerationYql(pageSize, offset),
        { 'presentation.summary': 'full' },
      );
      const totalCount = response.root.fields?.totalCount ?? 0;
      const hits = response.root.children ?? [];
      const docs: VespaDocEnvelope[] = [];
      for (const hit of hits) {
        const entityIdRaw = hit.fields['entity_id'];
        const snapshotIdRaw = hit.fields['search_snapshot_id'];
        if (typeof entityIdRaw !== 'string' || entityIdRaw.length === 0) {
          throw new Error(
            `Vespa cleanup enumeration returned a hit without entity_id (offset=${String(offset)})`,
          );
        }
        if (typeof snapshotIdRaw !== 'string' || snapshotIdRaw.length === 0) {
          throw new Error(
            `Vespa cleanup enumeration: entity_id=${entityIdRaw} missing search_snapshot_id`,
          );
        }
        docs.push({ entityId: entityIdRaw, snapshotId: snapshotIdRaw });
      }
      return { docs, totalCount };
    },
    async deleteDoc(entityId) {
      // VespaClient.delete already treats HTTP 404 as a no-op (idempotent)
      // and throws VespaHttpError for 4xx/5xx, which we let propagate so
      // the driver can fail loud on a 5xx (see runCleanup below).
      await vespa.delete(entityId);
    },
  };
}

/**
 * Pure driver: given a transport + flags, walk the index, classify each
 * doc, and delete the stale subset. Returns a structured report.
 *
 * Exported for testability — the CLI shell in `main()` only handles
 * argv, env, and process exit. All behaviour lives here.
 */
export async function runCleanup(args: {
  readonly vespa: VespaCleanupTransport;
  readonly pg: PgCleanupTransport;
  readonly flags: CleanupCliFlags;
  readonly log?: (msg: string) => void;
}): Promise<CleanupReport> {
  const log = args.log ?? ((msg: string) => {
    process.stdout.write(`${msg}\n`);
  });

  // -------------------------------------------------------------------------
  // Step 1: resolve protected snapshot set from PG.
  // -------------------------------------------------------------------------
  const rows = await args.pg.readActiveSnapshotRows();
  const pointer = parseActiveSnapshotRows(rows);
  const protectedSet = buildProtectedSet(
    pointer.active_snapshot_id,
    args.flags.excludeSnapshots,
  );
  log(
    `[cleanup] active_snapshot_id=${pointer.active_snapshot_id} ` +
      `protected={${[...protectedSet].join(', ')}} ` +
      `dryRun=${String(args.flags.dryRun)}`,
  );

  // -------------------------------------------------------------------------
  // Step 2: enumerate Vespa docs page by page, classify, delete stale.
  // -------------------------------------------------------------------------
  let enumerated = 0;
  let staleCount = 0;
  let deleted = 0;
  let failures = 0;
  let skippedByLimit = 0;
  let offset = 0;
  let totalCount = Number.POSITIVE_INFINITY;
  let progressTickAt = args.flags.progressInterval;

  while (offset < totalCount) {
    // Pre-flight guard: rule 20. If the limit is already hit, stop
    // enumerating — no point fetching more pages we cannot act on.
    if (args.flags.limit !== undefined && deleted >= args.flags.limit) {
      log(
        `[cleanup] --limit ${String(args.flags.limit)} reached (deleted=${String(deleted)}), stopping enumeration early`,
      );
      break;
    }

    const page = await args.vespa.enumerateDocs({
      pageSize: args.flags.pageSize,
      offset,
    });
    if (totalCount === Number.POSITIVE_INFINITY) {
      totalCount = page.totalCount;
      if (totalCount < MIN_EXPECTED_DOCS) {
        throw new Error(
          `Vespa enumeration returned totalCount=${String(totalCount)} (< ${String(MIN_EXPECTED_DOCS)}). ` +
            'Refusing to proceed — corpus appears empty or operator may be pointed at the wrong cluster.',
        );
      }
      log(`[cleanup] enumerating ${String(totalCount)} docs from Vespa`);
    }
    if (page.docs.length === 0) {
      break;
    }
    enumerated += page.docs.length;
    const stale = selectStaleDocs(page.docs, protectedSet);
    staleCount += stale.length;

    const { toDelete, skipped } = applyDeleteLimit(
      stale,
      deleted,
      args.flags.limit,
    );
    skippedByLimit += skipped;

    if (toDelete.length > 0) {
      if (args.flags.dryRun) {
        // Dry-run: do not call deleteDoc at all. Track as if deleted so
        // the report shows the would-delete count under `stale`. We
        // iterate by index rather than `for (const doc of toDelete)`
        // because the doc value itself is unused — only the count.
        for (let k = 0; k < toDelete.length; k += 1) {
          if (deleted + 1 >= progressTickAt) {
            log(
              `[cleanup] (dry-run) would delete ${String(deleted + 1)}/${String(staleCount)} stale docs`,
            );
            progressTickAt += args.flags.progressInterval;
          }
          deleted += 1;
        }
      } else {
        const result = await deleteBatch({
          docs: toDelete,
          batchSize: args.flags.batchSize,
          deleteDoc: args.vespa.deleteDoc.bind(args.vespa),
          onProgress: (delta) => {
            deleted += delta;
            if (deleted >= progressTickAt) {
              log(`[cleanup] deleted ${String(deleted)} stale docs`);
              progressTickAt += args.flags.progressInterval;
            }
          },
        });
        failures += result.failures;
      }
    }

    offset += page.docs.length;
  }

  log(
    `[cleanup] done — enumerated=${String(enumerated)} stale=${String(staleCount)} ` +
      `deleted=${String(deleted)} skippedByLimit=${String(skippedByLimit)} failures=${String(failures)}`,
  );

  return {
    enumerated,
    stale: staleCount,
    deleted,
    skippedByLimit,
    failures,
    dryRun: args.flags.dryRun,
    activeSnapshotId: pointer.active_snapshot_id,
    protectedSnapshotIds: [...protectedSet],
  };
}

/**
 * Parallel delete worker pool. Mirrors the pattern in
 * `VespaClient.bulkFeed`: a fixed number of workers pull from a shared
 * index and call the delete function. Failures are counted, not thrown,
 * so a single transient error does not abort the whole run; but the
 * `deleteDoc` impl is expected to throw on 5xx (caught here as a failure)
 * — only repeated 5xx warrant a manual abort.
 */
async function deleteBatch(args: {
  readonly docs: readonly VespaDocEnvelope[];
  readonly batchSize: number;
  readonly deleteDoc: (entityId: string) => Promise<void>;
  readonly onProgress: (delta: number) => void;
}): Promise<{ readonly failures: number }> {
  let failures = 0;
  const concurrency = Math.max(1, Math.min(args.batchSize, args.docs.length));
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (nextIndex < args.docs.length) {
      const i = nextIndex;
      nextIndex += 1;
      const doc = args.docs[i];
      if (doc === undefined) {
        continue;
      }
      try {
        await args.deleteDoc(doc.entityId);
        args.onProgress(1);
      } catch (err) {
        failures += 1;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[cleanup] delete failed: entity_id=${doc.entityId}: ${message}\n`,
        );
        // Rule 19-adjacent: if the cluster is returning 5xx, every
        // subsequent delete is likely to fail too. We rely on
        // VespaClient's withRetry exponential backoff to soak short
        // blips; a persistent error reaches us here and we count it.
        // The driver loops over pages and a stuck cluster will surface
        // as failures-per-page = page-size, an operator-visible signal.
      }
    }
  });
  await Promise.all(workers);
  return { failures };
}

/**
 * CLI entry. Constructs the live VespaClient + PG Pool, runs the driver,
 * prints the JSON report, exits with non-zero on any failure.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let flags: CleanupCliFlags;
  try {
    flags = parseCleanupArgs(argv);
  } catch (err) {
    if (err instanceof Error && err.message === '__HELP__') {
      process.stdout.write(buildHelpText());
      return;
    }
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n\n`);
    process.stderr.write(buildHelpText());
    process.exitCode = 2;
    return;
  }

  const vespaUrl = requireEnv('VESPA_URL');
  const vespaCert = requireEnv('VESPA_CERT_PATH');
  const vespaKey = requireEnv('VESPA_KEY_PATH');
  const databaseUrl = requireEnv('DATABASE_URL');

  const vespaClient = new VespaClient(
    vespaUrl.replace(/\/$/, ''),
    VESPA_CLEANUP_NAMESPACE,
    VESPA_CLEANUP_DOC_TYPE,
    undefined,
    { certPath: vespaCert, keyPath: vespaKey },
  );
  const transport = createVespaCleanupTransport(vespaClient);

  const pool = new Pool({ connectionString: databaseUrl });
  const pgTransport: PgCleanupTransport = {
    async readActiveSnapshotRows() {
      const res = await pool.query(
        `SELECT active_snapshot_id, previous_snapshot_id FROM active_search_snapshot WHERE id = 1`,
      );
      return res.rows;
    },
  };

  try {
    const report = await runCleanup({ vespa: transport, pg: pgTransport, flags });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failures > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim().length === 0) {
    throw new Error(`stale-snapshot-cleanup: missing required env ${name}`);
  }
  return v.trim();
}

function buildHelpText(): string {
  return [
    'Usage: pnpm tsx tools/vespa-cleanup/stale-snapshot-cleanup.ts [flags]',
    '',
    'Flags:',
    '  --dry-run                 Report only, don\'t delete',
    `  --batch-size N            Delete concurrency cap (default ${String(DEFAULT_DELETE_CONCURRENCY)})`,
    `  --page-size N             YQL enumeration window (default ${String(DEFAULT_PAGE_SIZE)}, max ${String(MAX_PAGE_SIZE)})`,
    '  --limit N                 Cap total deletes (safety brake)',
    '  --exclude-snapshot <id>   Additional snapshot id to keep (repeatable)',
    `  --progress-interval N     Print progress every N deletes (default ${String(DEFAULT_PROGRESS_INTERVAL)})`,
    '  --help, -h                Show this help text',
    '',
  ].join('\n');
}

// Run only when invoked directly via tsx, not when imported by tests.
// import.meta.url resolves to the .ts path under tsx; the .js suffix
// would never appear at runtime in this hook.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`stale-snapshot-cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
