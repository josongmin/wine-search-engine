/**
 * Wave 4 regression — `tools/vespa-cleanup/stale-snapshot-cleanup.ts`.
 *
 * Vespa `wine_entity` accumulates documents from previous publish runs.
 * The off-band cleanup CLI must:
 *   - Resolve the active snapshot id from `active_search_snapshot`.
 *   - Enumerate the entire corpus (not just the active subset).
 *   - Delete only docs whose `search_snapshot_id` is outside the
 *     protected set.
 *   - Fail loud on missing / multi-row pointer table.
 *   - Tolerate per-doc 404 (idempotent delete) but propagate 5xx.
 *   - Honor --dry-run / --limit / --exclude-snapshot.
 *
 * These tests stub the Vespa + PG transports so no live cluster is touched.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyDeleteLimit,
  buildProtectedSet,
  classifyDoc,
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
} from '../../tools/vespa-cleanup/cleanup-core.ts';
import {
  type PgCleanupTransport,
  runCleanup,
  type VespaCleanupTransport,
} from '../../tools/vespa-cleanup/stale-snapshot-cleanup.ts';

const ACTIVE_SNAPSHOT = '12f0ec1f91365d2e';
const STALE_SNAPSHOT_A = '79e799ca01bb9a9a';
const STALE_SNAPSHOT_B = 'b55f1c00a6eb6beb';

function makeDoc(entityId: string, snapshotId: string): VespaDocEnvelope {
  return { entityId, snapshotId };
}

function makePg(rows: readonly unknown[]): PgCleanupTransport {
  return {
    readActiveSnapshotRows: vi.fn().mockResolvedValue(rows),
  };
}

interface FakeVespa extends VespaCleanupTransport {
  readonly deletedIds: string[];
  /** Test-side counter; reads as a number. */
  getEnumerateCalls(): number;
}

function makeFakeVespa(
  docs: readonly VespaDocEnvelope[],
  options?: { readonly deleteImpl?: (entityId: string) => Promise<void> },
): FakeVespa {
  const deletedIds: string[] = [];
  const state = { enumerateCalls: 0 };
  return {
    async enumerateDocs({ pageSize, lastEntityId }) {
      state.enumerateCalls += 1;
      // Cursor-style: skip docs <= lastEntityId, take next pageSize.
      const startIdx = lastEntityId === ''
        ? 0
        : docs.findIndex((d) => d.entityId > lastEntityId);
      const slice = startIdx < 0
        ? []
        : docs.slice(startIdx, startIdx + pageSize);
      return Promise.resolve({ docs: slice, totalCount: docs.length });
    },
    async deleteDoc(entityId: string) {
      if (options?.deleteImpl !== undefined) {
        await options.deleteImpl(entityId);
      }
      deletedIds.push(entityId);
    },
    async countDocsBySnapshot(snapshotId: string) {
      // Default: derive count from the test corpus so happy-path tests
      // don't need to pass an explicit `countDocsBySnapshot` impl. Tests
      // that exercise the publish-then-cleanup race override the
      // `countDocsBySnapshot` method directly on the returned object.
      let count = 0;
      for (const d of docs) if (d.snapshotId === snapshotId) count += 1;
      return Promise.resolve(count);
    },
    deletedIds,
    getEnumerateCalls: () => state.enumerateCalls,
  };
}

const baseFlags = {
  dryRun: false,
  batchSize: DEFAULT_DELETE_CONCURRENCY,
  progressInterval: DEFAULT_PROGRESS_INTERVAL,
  pageSize: DEFAULT_PAGE_SIZE,
  excludeSnapshots: [] as readonly string[],
  // Post-2026-05-25 hardening defaults — see `buildProtectedSet` doc.
  protectPrevious: true,
  // Tests pass `minActiveTagged: 0` when they want to bypass the
  // corpus-wipe guard (most enumeration/scoring tests are not about
  // verifying the guard itself).
  minActiveTagged: 0,
};

// ===========================================================================
// Pure helper tests
// ===========================================================================

describe('classifyDoc / selectStaleDocs (pure)', () => {
  it('keeps docs in the protected set', () => {
    const protectedSet = new Set([ACTIVE_SNAPSHOT]);
    expect(classifyDoc(makeDoc('e1', ACTIVE_SNAPSHOT), protectedSet).verdict).toBe('keep');
  });

  it('marks docs outside the protected set as stale', () => {
    const protectedSet = new Set([ACTIVE_SNAPSHOT]);
    expect(classifyDoc(makeDoc('e2', STALE_SNAPSHOT_A), protectedSet).verdict).toBe('stale');
  });

  it('selectStaleDocs filters and preserves enumeration order', () => {
    const protectedSet = new Set([ACTIVE_SNAPSHOT]);
    const docs = [
      makeDoc('e1', ACTIVE_SNAPSHOT),
      makeDoc('e2', STALE_SNAPSHOT_A),
      makeDoc('e3', STALE_SNAPSHOT_B),
      makeDoc('e4', ACTIVE_SNAPSHOT),
    ];
    const stale = selectStaleDocs(docs, protectedSet);
    expect(stale.map((d) => d.entityId)).toEqual(['e2', 'e3']);
  });

  it('buildProtectedSet includes operator excludes', () => {
    const set = buildProtectedSet(ACTIVE_SNAPSHOT, [STALE_SNAPSHOT_A]);
    expect(set.has(ACTIVE_SNAPSHOT)).toBe(true);
    expect(set.has(STALE_SNAPSHOT_A)).toBe(true);
    expect(set.has(STALE_SNAPSHOT_B)).toBe(false);
  });

  it('buildProtectedSet dedups when active is also in excludes', () => {
    const set = buildProtectedSet(ACTIVE_SNAPSHOT, [ACTIVE_SNAPSHOT, STALE_SNAPSHOT_A]);
    expect(set.size).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Post-2026-05-25 hardening: buildProtectedSet auto-protects
  // `previous_snapshot_id` by default. The corpus-wipe incident happened
  // because the previous snapshot was NOT protected and ETL had not yet
  // indexed the new active's docs.
  // -----------------------------------------------------------------------
  it('buildProtectedSet auto-protects previous_snapshot_id (default ON)', () => {
    const set = buildProtectedSet(ACTIVE_SNAPSHOT, [], STALE_SNAPSHOT_A);
    expect(set.has(ACTIVE_SNAPSHOT)).toBe(true);
    expect(set.has(STALE_SNAPSHOT_A)).toBe(true);
  });

  it('buildProtectedSet skips previous when protectPrevious=false', () => {
    const set = buildProtectedSet(ACTIVE_SNAPSHOT, [], STALE_SNAPSHOT_A, false);
    expect(set.has(ACTIVE_SNAPSHOT)).toBe(true);
    expect(set.has(STALE_SNAPSHOT_A)).toBe(false);
  });

  it('buildProtectedSet handles null previous (first publish)', () => {
    const set = buildProtectedSet(ACTIVE_SNAPSHOT, [], null);
    expect(set.size).toBe(1);
    expect(set.has(ACTIVE_SNAPSHOT)).toBe(true);
  });

  it('buildProtectedSet ignores empty-string previous', () => {
    const set = buildProtectedSet(ACTIVE_SNAPSHOT, [], '');
    expect(set.size).toBe(1);
  });

  it('buildProtectedSet does NOT double-add when previous equals active', () => {
    const set = buildProtectedSet(ACTIVE_SNAPSHOT, [], ACTIVE_SNAPSHOT);
    expect(set.size).toBe(1);
  });
});

describe('applyDeleteLimit (pure)', () => {
  const batch = [makeDoc('e1', 'x'), makeDoc('e2', 'x'), makeDoc('e3', 'x')];

  it('no limit → deletes everything', () => {
    expect(applyDeleteLimit(batch, 0, undefined)).toEqual({ toDelete: batch, skipped: 0 });
  });

  it('limit larger than remaining batch → deletes everything', () => {
    expect(applyDeleteLimit(batch, 0, 10).toDelete).toEqual(batch);
  });

  it('limit smaller than batch → slices and reports skipped', () => {
    const result = applyDeleteLimit(batch, 0, 2);
    expect(result.toDelete.map((d) => d.entityId)).toEqual(['e1', 'e2']);
    expect(result.skipped).toBe(1);
  });

  it('limit already reached → toDelete empty', () => {
    const result = applyDeleteLimit(batch, 2, 2);
    expect(result.toDelete).toEqual([]);
    expect(result.skipped).toBe(3);
  });

  it('limit=0 deletes nothing', () => {
    const result = applyDeleteLimit(batch, 0, 0);
    expect(result.toDelete).toEqual([]);
    expect(result.skipped).toBe(3);
  });

  it('partial pre-existing deletes → respects remaining quota', () => {
    const result = applyDeleteLimit(batch, 1, 2);
    expect(result.toDelete.map((d) => d.entityId)).toEqual(['e1']);
    expect(result.skipped).toBe(2);
  });
});

// ===========================================================================
// parseActiveSnapshotRows — fail-loud invariants
// ===========================================================================

describe('parseActiveSnapshotRows', () => {
  it('accepts the singleton row', () => {
    const parsed = parseActiveSnapshotRows([
      { active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: STALE_SNAPSHOT_A },
    ]);
    expect(parsed.active_snapshot_id).toBe(ACTIVE_SNAPSHOT);
    expect(parsed.previous_snapshot_id).toBe(STALE_SNAPSHOT_A);
  });

  it('accepts null previous_snapshot_id (first publish)', () => {
    const parsed = parseActiveSnapshotRows([
      { active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null },
    ]);
    expect(parsed.previous_snapshot_id).toBeNull();
  });

  it('throws on empty rows (refuse to delete everything by default)', () => {
    expect(() => parseActiveSnapshotRows([])).toThrow(/active_search_snapshot is empty/);
  });

  it('throws on multiple rows (singleton CHECK violated)', () => {
    expect(() =>
      parseActiveSnapshotRows([
        { active_snapshot_id: 'a', previous_snapshot_id: null },
        { active_snapshot_id: 'b', previous_snapshot_id: null },
      ]),
    ).toThrow(/has 2 rows; expected exactly 1/);
  });

  it('throws when column missing (Zod shape mismatch)', () => {
    expect(() => parseActiveSnapshotRows([{ wrong_column: 'x' }])).toThrow(/shape invalid/);
  });

  it('throws when active_snapshot_id is empty string', () => {
    expect(() =>
      parseActiveSnapshotRows([{ active_snapshot_id: '', previous_snapshot_id: null }]),
    ).toThrow(/shape invalid/);
  });
});

// ===========================================================================
// parseCleanupArgs — flag parsing
// ===========================================================================

describe('parseCleanupArgs', () => {
  it('returns defaults on empty argv', () => {
    const flags = parseCleanupArgs([]);
    expect(flags.dryRun).toBe(false);
    expect(flags.batchSize).toBe(DEFAULT_DELETE_CONCURRENCY);
    expect(flags.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(flags.limit).toBeUndefined();
    expect(flags.excludeSnapshots).toEqual([]);
    // Post-2026-05-25 hardening defaults: previous-snapshot auto-protect
    // ON, min-active-tagged guard requires >= 1.
    expect(flags.protectPrevious).toBe(true);
    expect(flags.minActiveTagged).toBe(1);
  });

  it('parses --no-protect-previous', () => {
    expect(parseCleanupArgs(['--no-protect-previous']).protectPrevious).toBe(false);
  });

  it('parses --min-active-tagged N', () => {
    expect(parseCleanupArgs(['--min-active-tagged', '100']).minActiveTagged).toBe(100);
  });

  it('parses --min-active-tagged 0 as explicit guard disable', () => {
    expect(parseCleanupArgs(['--min-active-tagged', '0']).minActiveTagged).toBe(0);
  });

  it('throws on negative --min-active-tagged', () => {
    expect(() => parseCleanupArgs(['--min-active-tagged', '-1'])).toThrow(
      /non-negative integer/,
    );
  });

  it('parses --dry-run', () => {
    expect(parseCleanupArgs(['--dry-run']).dryRun).toBe(true);
  });

  it('parses --batch-size and --limit', () => {
    const flags = parseCleanupArgs(['--batch-size', '8', '--limit', '500']);
    expect(flags.batchSize).toBe(8);
    expect(flags.limit).toBe(500);
  });

  it('parses repeated --exclude-snapshot', () => {
    const flags = parseCleanupArgs([
      '--exclude-snapshot',
      STALE_SNAPSHOT_A,
      '--exclude-snapshot',
      STALE_SNAPSHOT_B,
    ]);
    expect(flags.excludeSnapshots).toEqual([STALE_SNAPSHOT_A, STALE_SNAPSHOT_B]);
  });

  it('throws on unknown flag', () => {
    expect(() => parseCleanupArgs(['--batchsize', '8'])).toThrow(/Unknown flag/);
  });

  it('throws on non-numeric batch-size', () => {
    expect(() => parseCleanupArgs(['--batch-size', 'eight'])).toThrow(/positive integer/);
  });

  it('throws on negative batch-size', () => {
    expect(() => parseCleanupArgs(['--batch-size', '-1'])).toThrow(/positive integer/);
  });

  it('throws on zero batch-size', () => {
    expect(() => parseCleanupArgs(['--batch-size', '0'])).toThrow(/positive integer/);
  });

  it('throws on page-size exceeding MAX_PAGE_SIZE', () => {
    expect(() => parseCleanupArgs(['--page-size', String(MAX_PAGE_SIZE + 1)])).toThrow(
      /exceeds MAX_PAGE_SIZE/,
    );
  });

  it('throws when --exclude-snapshot value missing', () => {
    expect(() => parseCleanupArgs(['--exclude-snapshot'])).toThrow(/requires a snapshot id/);
  });

  it('throws when --exclude-snapshot value looks like another flag', () => {
    expect(() => parseCleanupArgs(['--exclude-snapshot', '--dry-run'])).toThrow(
      /requires a snapshot id/,
    );
  });
});

// ===========================================================================
// runCleanup — end-to-end driver with mocked transports
// ===========================================================================

// ===========================================================================
// 2026-05-25 incident regression — publish-then-cleanup race wipes corpus.
//
// Scenario: PG `active_search_snapshot.active_snapshot_id` flipped to a NEW
// snapshot id, but Vespa indexing of that new snapshot has not begun (so
// 0 docs are tagged with the new id). The old corpus (11K docs in prod) is
// still tagged with the previous snapshot id. The original cleanup CLI
// classified every old doc as `stale` and reaped the entire corpus.
// ===========================================================================

describe('runCleanup pre-flight guard (corpus-wipe race)', () => {
  it('aborts when 0 docs are tagged with the new active snapshot', async () => {
    const NEW_ACTIVE = 'newly-published-snapshot-id';
    // Vespa still holds the previous corpus, none tagged with NEW_ACTIVE.
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', STALE_SNAPSHOT_A),
      makeDoc('e2', STALE_SNAPSHOT_A),
      makeDoc('e3', STALE_SNAPSHOT_A),
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([
      { active_snapshot_id: NEW_ACTIVE, previous_snapshot_id: STALE_SNAPSHOT_A },
    ]);
    // protectPrevious=false to isolate the count-guard from the
    // previous-protect rule. minActiveTagged=1 (the default) — we expect
    // the guard to fire because NEW_ACTIVE has 0 tagged docs.
    await expect(
      runCleanup({
        vespa,
        pg,
        flags: { ...baseFlags, protectPrevious: false, minActiveTagged: 1 },
        log: () => undefined,
      }),
    ).rejects.toThrow(/below --min-active-tagged|wipe the serving corpus/);
    // Critical: zero deletes happened.
    expect(vespa.deletedIds).toEqual([]);
  });

  it('proceeds when active-tagged count meets the threshold', async () => {
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', ACTIVE_SNAPSHOT),
      makeDoc('e2', ACTIVE_SNAPSHOT),
      makeDoc('e3', STALE_SNAPSHOT_A),
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([
      { active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null },
    ]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, minActiveTagged: 1 },
      log: () => undefined,
    });
    expect(report.deleted).toBe(1);
    expect(vespa.deletedIds).toEqual(['e3']);
  });

  it('minActiveTagged=0 disables the guard (explicit override)', async () => {
    const NEW_ACTIVE = 'newly-published-snapshot-id';
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', STALE_SNAPSHOT_A),
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([
      { active_snapshot_id: NEW_ACTIVE, previous_snapshot_id: null },
    ]);
    // minActiveTagged=0 + protectPrevious=false → guard disabled,
    // previous unprotected. The lone stale doc gets reaped.
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, protectPrevious: false, minActiveTagged: 0 },
      log: () => undefined,
    });
    expect(report.deleted).toBe(1);
  });

  it('previous-snapshot auto-protect keeps the old corpus alive during race', async () => {
    const NEW_ACTIVE = 'newly-published-snapshot-id';
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', NEW_ACTIVE), // one new-active doc — guard passes
      makeDoc('e2', STALE_SNAPSHOT_A),
      makeDoc('e3', STALE_SNAPSHOT_A),
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([
      { active_snapshot_id: NEW_ACTIVE, previous_snapshot_id: STALE_SNAPSHOT_A },
    ]);
    // Defaults: protectPrevious=true → STALE_SNAPSHOT_A is protected, so
    // even though e2/e3 are tagged with it, they survive the cleanup.
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, minActiveTagged: 1 },
      log: () => undefined,
    });
    expect(report.deleted).toBe(0);
    expect(vespa.deletedIds).toEqual([]);
    expect(report.stale).toBe(0);
  });

  it('--no-protect-previous + --min-active-tagged 0 reverts to legacy behavior', async () => {
    // Reaping previous-snapshot leftovers is still possible — but
    // operators must consciously opt out of BOTH safety nets.
    const NEW_ACTIVE = 'newly-published-snapshot-id';
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', STALE_SNAPSHOT_A),
      makeDoc('e2', STALE_SNAPSHOT_A),
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([
      { active_snapshot_id: NEW_ACTIVE, previous_snapshot_id: STALE_SNAPSHOT_A },
    ]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, protectPrevious: false, minActiveTagged: 0 },
      log: () => undefined,
    });
    expect(report.deleted).toBe(2);
  });
});

describe('runCleanup driver', () => {
  it('deletes only docs outside the active snapshot', async () => {
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', ACTIVE_SNAPSHOT),
      makeDoc('e2', STALE_SNAPSHOT_A),
      makeDoc('e3', STALE_SNAPSHOT_B),
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([{ active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null }]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: baseFlags,
      log: () => undefined,
    });

    expect(vespa.deletedIds.sort()).toEqual(['e2', 'e3']);
    expect(report.enumerated).toBe(3);
    expect(report.stale).toBe(2);
    expect(report.deleted).toBe(2);
    expect(report.failures).toBe(0);
    expect(report.activeSnapshotId).toBe(ACTIVE_SNAPSHOT);
  });

  it('--dry-run performs 0 actual deletes', async () => {
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', ACTIVE_SNAPSHOT),
      makeDoc('e2', STALE_SNAPSHOT_A),
      makeDoc('e3', STALE_SNAPSHOT_B),
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([{ active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null }]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, dryRun: true },
      log: () => undefined,
    });

    expect(vespa.deletedIds).toEqual([]);
    expect(report.dryRun).toBe(true);
    expect(report.stale).toBe(2);
    expect(report.deleted).toBe(2); // would-delete count
  });

  it('--limit caps actual deletes and stops enumeration early', async () => {
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', STALE_SNAPSHOT_A),
      makeDoc('e2', STALE_SNAPSHOT_A),
      makeDoc('e3', STALE_SNAPSHOT_A),
      makeDoc('e4', STALE_SNAPSHOT_A),
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([{ active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null }]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, pageSize: 2, limit: 1 },
      log: () => undefined,
    });

    expect(vespa.deletedIds.length).toBe(1);
    expect(report.deleted).toBe(1);
    expect(report.skippedByLimit).toBeGreaterThan(0);
  });

  it('--exclude-snapshot preserves additional snapshots', async () => {
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', ACTIVE_SNAPSHOT),
      makeDoc('e2', STALE_SNAPSHOT_A), // operator says keep
      makeDoc('e3', STALE_SNAPSHOT_B), // delete
    ];
    const vespa = makeFakeVespa(docs);
    const pg = makePg([{ active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null }]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, excludeSnapshots: [STALE_SNAPSHOT_A] },
      log: () => undefined,
    });

    expect(vespa.deletedIds).toEqual(['e3']);
    expect(report.protectedSnapshotIds.sort()).toEqual([ACTIVE_SNAPSHOT, STALE_SNAPSHOT_A].sort());
  });

  it('throws when active_search_snapshot is empty', async () => {
    const vespa = makeFakeVespa([makeDoc('e1', ACTIVE_SNAPSHOT)]);
    const pg = makePg([]);
    await expect(
      runCleanup({ vespa, pg, flags: baseFlags, log: () => undefined }),
    ).rejects.toThrow(/active_search_snapshot is empty/);
    expect(vespa.deletedIds).toEqual([]);
  });

  it('throws when active_search_snapshot has multiple rows', async () => {
    const vespa = makeFakeVespa([makeDoc('e1', ACTIVE_SNAPSHOT)]);
    const pg = makePg([
      { active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null },
      { active_snapshot_id: STALE_SNAPSHOT_A, previous_snapshot_id: null },
    ]);
    await expect(
      runCleanup({ vespa, pg, flags: baseFlags, log: () => undefined }),
    ).rejects.toThrow(/expected exactly 1/);
  });

  it('throws when enumeration returns 0 docs (suspicious empty corpus)', async () => {
    const vespa: VespaCleanupTransport = {
      enumerateDocs: vi.fn().mockResolvedValue({ docs: [], totalCount: 0 }),
      deleteDoc: vi.fn(),
    };
    const pg = makePg([{ active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null }]);
    await expect(
      runCleanup({ vespa, pg, flags: baseFlags, log: () => undefined }),
    ).rejects.toThrow(/Refusing to proceed/);
  });

  it('propagates HTTP 5xx errors raised by deleteDoc as failures (no crash)', async () => {
    const docs: VespaDocEnvelope[] = [
      makeDoc('e1', STALE_SNAPSHOT_A),
      makeDoc('e2', STALE_SNAPSHOT_A),
    ];
    let calls = 0;
    const vespa = makeFakeVespa(docs, {
      deleteImpl: () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('Vespa document DELETE failed [HTTP 503]: backend timeout');
        }
        return Promise.resolve();
      },
    });
    const pg = makePg([{ active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null }]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, batchSize: 1 },
      log: () => undefined,
    });

    expect(report.failures).toBeGreaterThanOrEqual(1);
    // Driver continued and processed the second doc even though the first failed.
    expect(report.enumerated).toBe(2);
  });

  it('tolerates HTTP 404 (idempotent) when delete impl resolves silently', async () => {
    // VespaClient.delete already maps 404→no-throw, so the transport sees
    // it as a successful resolve. Verify the driver counts it as deleted.
    const docs: VespaDocEnvelope[] = [makeDoc('e1', STALE_SNAPSHOT_A)];
    const vespa = makeFakeVespa(docs, {
      deleteImpl: async () => { await Promise.resolve(); },
    });
    const pg = makePg([{ active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null }]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: baseFlags,
      log: () => undefined,
    });
    expect(report.deleted).toBe(1);
    expect(report.failures).toBe(0);
  });

  it('paginates over multiple windows until totalCount is reached', async () => {
    const docs: VespaDocEnvelope[] = Array.from({ length: 7 }, (_, i) =>
      makeDoc(`e${String(i + 1)}`, STALE_SNAPSHOT_A),
    );
    const vespa = makeFakeVespa(docs);
    const pg = makePg([{ active_snapshot_id: ACTIVE_SNAPSHOT, previous_snapshot_id: null }]);
    const report = await runCleanup({
      vespa,
      pg,
      flags: { ...baseFlags, pageSize: 3 },
      log: () => undefined,
    });
    expect(vespa.deletedIds.length).toBe(7);
    expect(report.deleted).toBe(7);
    // 7 docs / pageSize 3 = ceil = 3 pages
    expect(vespa.getEnumerateCalls()).toBe(3);
  });
});

// ===========================================================================
// Module wiring sanity — constants match production publish script
// ===========================================================================

describe('Vespa cleanup wiring sanity', () => {
  it('targets the same namespace + doctype as publish-search-snapshot.ts', () => {
    expect(VESPA_CLEANUP_NAMESPACE).toBe('wine');
    expect(VESPA_CLEANUP_DOC_TYPE).toBe('wine_entity');
  });
});
