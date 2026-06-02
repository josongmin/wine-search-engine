import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { getPgPool } from './pg-pool.js';

/**
 * Checksum algorithm recorded alongside each applied migration. Kept as a
 * named const (Rule 15/30) so the ledger schema default, the value we INSERT,
 * and the hash we compute below can never drift apart.
 */
const CHECKSUM_ALGO = 'sha256';

/**
 * Filename of the ledger-table migration itself. It is run unconditionally on
 * every boot (its body is `CREATE TABLE IF NOT EXISTS`, so re-running is a
 * no-op) BEFORE we can query the ledger — there is no other way to guarantee
 * the table exists. Treating it as the ordering anchor also avoids an
 * infinite "the ledger isn't recorded so re-run it" loop: we upsert its row
 * right after creating the table.
 */
const LEDGER_MIGRATION_FILENAME = '000_schema_migrations.sql';

/** sha256 hex digest of a migration file's textual contents. */
function checksumOf(contents: string): string {
  return createHash(CHECKSUM_ALGO).update(contents, 'utf-8').digest('hex');
}

/**
 * Shape of a single ledger row we read back from PostgreSQL. Rule 11: DB rows
 * are external data — never cast with `as`; validate the shape at runtime.
 */
interface AppliedMigrationRow {
  readonly filename: string;
  readonly content_checksum: string;
}

function isAppliedMigrationRow(value: unknown): value is AppliedMigrationRow {
  if (typeof value !== 'object' || value === null) return false;
  const filename: unknown = (value as Record<string, unknown>)['filename'];
  const checksum: unknown = (value as Record<string, unknown>)['content_checksum'];
  return typeof filename === 'string' && typeof checksum === 'string';
}

/**
 * Defensively extract `.rows` from a pg query result. The result is treated as
 * `unknown` (Rule 11 — DB responses are external data) and the `rows` array is
 * validated per-element by {@link isAppliedMigrationRow} before use.
 */
function extractRows(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return undefined;
  return (result as Record<string, unknown>)['rows'];
}

/**
 * Apply bundled SQL migrations idempotently, gated by the `schema_migrations`
 * ledger.
 *
 * Algorithm:
 *  1. Run the ledger migration (000) unconditionally — `CREATE TABLE IF NOT
 *     EXISTS` makes this safe — then upsert its own ledger row so it is
 *     skippable on subsequent boots.
 *  2. Read every already-applied (filename, content_checksum) pair.
 *  3. For each remaining .sql file, compute its sha256 checksum and:
 *     - SKIP if (filename, checksum) is already recorded (no-op, fast path).
 *     - REFUSE (loud warn, skip) if the filename is recorded with a DIFFERENT
 *       checksum — the file was rewritten after being applied. Silently
 *       re-running edited migrations corrupts schema/data, so we never do it.
 *     - APPLY otherwise (new file), then upsert the ledger row.
 */
export async function runMigrations(): Promise<void> {
  const pool = getPgPool();
  const __dir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(__dir, 'migrations');
  const migrationFiles = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'));

  // ── Step 1: ensure the ledger table exists (run 000 unconditionally). ──
  const ledgerSql = readFileSync(join(migrationsDir, LEDGER_MIGRATION_FILENAME), 'utf-8');
  await pool.query(ledgerSql);
  await pool.query(
    `INSERT INTO schema_migrations (filename, content_checksum, checksum_algo)
     VALUES ($1, $2, $3)
     ON CONFLICT (filename) DO UPDATE SET
       content_checksum = EXCLUDED.content_checksum,
       checksum_algo = EXCLUDED.checksum_algo,
       applied_at = NOW()`,
    [LEDGER_MIGRATION_FILENAME, checksumOf(ledgerSql), CHECKSUM_ALGO],
  );

  // ── Step 2: read already-applied (filename → checksum). ──
  const appliedResult: unknown = await pool.query(
    'SELECT filename, content_checksum FROM schema_migrations',
  );
  const applied = new Map<string, string>();
  const rows: unknown = extractRows(appliedResult);
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (isAppliedMigrationRow(row)) {
        applied.set(row.filename, row.content_checksum);
      } else {
        bootstrapLogger.warn(
          { row },
          'schema_migrations row failed shape validation — ignoring',
        );
      }
    }
  }

  // ── Step 3: apply new/unrecorded files; refuse rewritten ones. ──
  let appliedCount = 0;
  let skippedCount = 0;
  let mismatchCount = 0;
  for (const fileName of migrationFiles) {
    // 000 was handled in step 1 (run + upserted) — skip it here.
    if (fileName === LEDGER_MIGRATION_FILENAME) continue;

    const sql = readFileSync(join(migrationsDir, fileName), 'utf-8');
    const checksum = checksumOf(sql);
    const recordedChecksum = applied.get(fileName);

    if (recordedChecksum === checksum) {
      // Already applied with identical contents — fast path, no-op.
      skippedCount += 1;
      continue;
    }

    if (recordedChecksum !== undefined) {
      // Filename applied before, but the file content changed afterward.
      // Re-running an edited migration can corrupt the schema/data, so we
      // refuse: loud warn + skip. Operators must add a NEW migration file
      // (next number) instead of editing an applied one.
      mismatchCount += 1;
      bootstrapLogger.warn(
        { migration: fileName, recordedChecksum, currentChecksum: checksum, checksumAlgo: CHECKSUM_ALGO },
        'Migration file changed after it was applied — REFUSING to re-run. ' +
          'Add a new migration file instead of editing an applied one.',
      );
      continue;
    }

    // New, never-applied migration — apply it and record the ledger row.
    await pool.query(sql);
    await pool.query(
      `INSERT INTO schema_migrations (filename, content_checksum, checksum_algo)
       VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO UPDATE SET
         content_checksum = EXCLUDED.content_checksum,
         checksum_algo = EXCLUDED.checksum_algo,
         applied_at = NOW()`,
      [fileName, checksum, CHECKSUM_ALGO],
    );
    appliedCount += 1;
    bootstrapLogger.warn({ migration: fileName }, 'Migration applied');
  }

  bootstrapLogger.warn(
    {
      migrationCount: migrationFiles.length,
      appliedCount,
      skippedCount,
      mismatchCount,
    },
    'Migrations complete',
  );
}
