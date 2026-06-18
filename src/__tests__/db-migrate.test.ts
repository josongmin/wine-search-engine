import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

// ── In-memory PG mock that understands the ledger contract ──────────────────
// runMigrations() issues exactly four query shapes:
//   1. CREATE TABLE IF NOT EXISTS schema_migrations (...)
//   2. INSERT ... INTO schema_migrations ... ON CONFLICT ... (upsert ledger row)
//   3. SELECT filename, content_checksum FROM schema_migrations
//   4. arbitrary migration body SQL (the .sql file contents)
// We model the ledger as a Map keyed by filename so idempotency is observable.
interface FakeLedger {
  readonly rows: Map<string, { filename: string; content_checksum: string }>;
}

function makeFakePool(ledger: FakeLedger) {
  const appliedBodies: string[] = [];
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) {
      return { rows: [] };
    }
    if (/INSERT INTO schema_migrations/i.test(sql)) {
      const filename = String(params?.[0]);
      const checksum = String(params?.[1]);
      ledger.rows.set(filename, { filename, content_checksum: checksum });
      return { rows: [] };
    }
    if (/SELECT filename, content_checksum FROM schema_migrations/i.test(sql)) {
      return { rows: Array.from(ledger.rows.values()) };
    }
    // Arbitrary migration body.
    appliedBodies.push(sql);
    return { rows: [] };
  });
  return { query, appliedBodies };
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf-8').digest('hex');
}

// Single mutable fake-pool reference the pg-pool mock returns.
let fakePool: ReturnType<typeof makeFakePool>;
const getPgPool = vi.fn(() => fakePool);

// The ledger (000) file's body MUST contain the CREATE TABLE statement so the
// fake pool routes it to the schema-bootstrap branch (not "arbitrary body").
const LEDGER_BODY = 'CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT);';

// readFileSync returns deterministic, file-specific contents so checksums
// differ per file (real files differ — the mock must too).
const fileContents = new Map<string, string>();
const readFileSync = vi.fn((p: string) => {
  if (p.includes('000_schema_migrations.sql')) return LEDGER_BODY;
  for (const [name, body] of fileContents.entries()) {
    if (p.includes(name)) return body;
  }
  return `-- body for ${p}`;
});

vi.mock('fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- Vitest `importOriginal` needs a concrete module type.
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync };
});

vi.mock('../infrastructure/db/pg-pool.js', () => ({ getPgPool }));

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../infrastructure/db/migrations',
);

async function listMigrationFiles(): Promise<string[]> {
  // Use the REAL fs (importActual) for directory listing — the `fs` mock only
  // overrides `readFileSync`, and importing `node:fs` statically would trigger
  // the mock factory before its hoisted vars initialize.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- `vi.importActual` requires a module type operand.
  const { readdirSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'));
}

describe('runMigrations — ledger semantics', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const ledger: FakeLedger = { rows: new Map() };
    fakePool = makeFakePool(ledger);
    getPgPool.mockClear();
    readFileSync.mockClear();
    fileContents.clear();
    const { bootstrapLogger } = await import('../domain/shared/bootstrap-logger.js');
    warnSpy = vi.spyOn(bootstrapLogger, 'warn');
  });

  it('applies all bundled migrations on first run, then ZERO new files on reruns (idempotent)', async () => {
    const { runMigrations } = await import('../infrastructure/db/migrate.js');
    const files = await listMigrationFiles();
    // Excludes the ledger file (000) which is applied separately.
    const nonLedger = files.filter((f) => f !== '000_schema_migrations.sql');

    // Run 1: every non-ledger migration body executes once.
    await runMigrations();
    const run1Bodies = fakePool.appliedBodies.length;
    expect(run1Bodies).toBe(nonLedger.length);

    // Run 2 + 3: ledger already records every (filename, checksum) → no body
    // SQL executes (insert 0 / apply 0).
    fakePool.appliedBodies.length = 0;
    await runMigrations();
    expect(fakePool.appliedBodies.length).toBe(0);

    fakePool.appliedBodies.length = 0;
    await runMigrations();
    expect(fakePool.appliedBodies.length).toBe(0);
  });

  it('records a ledger row per applied migration after run 1', async () => {
    const { runMigrations } = await import('../infrastructure/db/migrate.js');
    const files = await listMigrationFiles();
    await runMigrations();
    // SELECT shape: query the ledger directly via the fake.
    const result = await fakePool.query(
      'SELECT filename, content_checksum FROM schema_migrations',
    );
    expect(result.rows.length).toBe(files.length); // includes the 000 ledger row
  });

  it('checksum-corruption: a wrong recorded checksum does NOT trigger a silent re-run', async () => {
    const { runMigrations } = await import('../infrastructure/db/migrate.js');
    const files = await listMigrationFiles();
    const victim = files.find((f) => f !== '000_schema_migrations.sql');
    expect(victim).toBeDefined();

    // Pre-seed the ledger with a WRONG checksum for an existing file (as if a
    // migration corrupted the row). The real file content differs from this.
    await runMigrations(); // populate ledger with correct checksums first
    // Now corrupt one row in place.
    const ledgerResult = await fakePool.query(
      'SELECT filename, content_checksum FROM schema_migrations',
    );
    expect(ledgerResult.rows.some((r: { filename: string }) => r.filename === victim)).toBe(true);

    // Mutate the fake ledger directly to a bogus checksum.
    fakePool.appliedBodies.length = 0;
    await fakePool.query(
      'INSERT INTO schema_migrations (filename, content_checksum, checksum_algo) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [victim, 'deadbeef-not-a-real-checksum', 'sha256'],
    );
    warnSpy.mockClear();

    await runMigrations();

    // The mismatched file must NOT have its body re-executed.
    expect(fakePool.appliedBodies.length).toBe(0);
    // A loud warn about the rewrite/mismatch must be emitted.
    const warnedMismatch = warnSpy.mock.calls.some((c) =>
      JSON.stringify(c).includes('REFUSING to re-run'),
    );
    expect(warnedMismatch).toBe(true);
  });

  it('file-rewrite detection: changing applied file content → warn + skip, no blind re-apply', async () => {
    const { runMigrations } = await import('../infrastructure/db/migrate.js');
    const files = await listMigrationFiles();
    const victim = files.find((f) => f !== '000_schema_migrations.sql');
    expect(victim).toBeDefined();
    const victimName = victim as string;

    // First run with original contents.
    fileContents.set(victimName, '-- original content v1');
    await runMigrations();

    // Now the file is REWRITTEN on disk (new content → new checksum).
    fileContents.set(victimName, '-- rewritten content v2 DIFFERENT');
    fakePool.appliedBodies.length = 0;
    warnSpy.mockClear();

    await runMigrations();

    // Rewritten file is NOT blindly re-applied.
    const reapplied = fakePool.appliedBodies.includes('-- rewritten content v2 DIFFERENT');
    expect(reapplied).toBe(false);
    // Loud warn names the changed migration.
    const warnedRewrite = warnSpy.mock.calls.some((c) =>
      JSON.stringify(c).includes('changed after it was applied'),
    );
    expect(warnedRewrite).toBe(true);
  });

  it('records the ledger checksum equal to sha256 of file contents', async () => {
    const { runMigrations } = await import('../infrastructure/db/migrate.js');
    const files = await listMigrationFiles();
    const victim = files.find((f) => f !== '000_schema_migrations.sql') as string;
    fileContents.set(victim, '-- deterministic body');
    await runMigrations();
    const result = await fakePool.query(
      'SELECT filename, content_checksum FROM schema_migrations',
    );
    const row = result.rows.find((r: { filename: string }) => r.filename === victim) as {
      content_checksum: string;
    };
    expect(row.content_checksum).toBe(sha256('-- deterministic body'));
  });
});
