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
