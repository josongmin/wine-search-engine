/**
 * T-010/W1: active_search_snapshot pointer contract regression.
 *
 * Contract:
 *  - promote is atomic: UPDATE + history INSERT in one TX
 *  - idempotent: setting same active_snapshot_id is no-op
 *  - first publish: INSERTs singleton row (id = 1)
 *  - rollback: reads previous_snapshot_id, swaps; fails if no previous
 *  - assertSnapshotNotAlreadyPublished: rejects re-publish of current active
 *
 * These tests use a mocked pool; pg interaction is exercised at integration
 * lane separately.
 */
import { describe, expect, it, vi } from 'vitest';
import { assertSnapshotNotAlreadyPublished } from '../../scripts/etl/publish-runtime-substrates.js';

describe('T-010 assertSnapshotNotAlreadyPublished', () => {
  it('passes when no pointer row exists (first publish)', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
     
    await expect(assertSnapshotNotAlreadyPublished(client as never, 'snap-new')).resolves.toBeUndefined();
  });

  it('passes when pointer exists but points elsewhere', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ active_snapshot_id: 'snap-other', previous_snapshot_id: null }],
      }),
    };
     
    await expect(assertSnapshotNotAlreadyPublished(client as never, 'snap-new')).resolves.toBeUndefined();
  });

  it('passes when snapshot is the previous one (rollback → re-publish)', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ active_snapshot_id: 'snap-current', previous_snapshot_id: 'snap-new' }],
      }),
    };
     
    await expect(assertSnapshotNotAlreadyPublished(client as never, 'snap-new')).resolves.toBeUndefined();
  });

  it('throws when snapshot is already the active one (double publish)', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ active_snapshot_id: 'snap-dup', previous_snapshot_id: null }],
      }),
    };
     
    await expect(assertSnapshotNotAlreadyPublished(client as never, 'snap-dup')).rejects.toThrow(
      /already the active snapshot/,
    );
  });

  it('surfaces snapshot id and guidance in error message', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{ active_snapshot_id: 'snap-XYZ', previous_snapshot_id: null }],
      }),
    };
    let capturedMsg = '';
    try {
       
      await assertSnapshotNotAlreadyPublished(client as never, 'snap-XYZ');
    } catch (e) {
      capturedMsg = e instanceof Error ? e.message : String(e);
    }
    expect(capturedMsg).toContain('snap-XYZ');
    expect(capturedMsg).toContain('fresh snapshot_id');
  });
});

describe('T-010 pointer migration SQL contract', () => {
  it('active_search_snapshot has singleton constraint (id = 1)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/migrations/010_active_search_snapshot_pointer.sql', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/CHECK\s*\(\s*id\s*=\s*1\s*\)/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS active_search_snapshot/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS active_search_snapshot_history/);
  });

  it('migration creates snapshot-scoped read indexes', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/migrations/010_active_search_snapshot_pointer.sql', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/idx_entities_search_snapshot/);
    expect(src).toMatch(/idx_aliases_search_snapshot/);
    expect(src).toMatch(/idx_ambiguity_registry_search_snapshot/);
  });
});

describe('T-010 publish-runtime-substrates append-only contract', () => {
  it('has no TRUNCATE TABLE calls in publish path', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-runtime-substrates.ts', import.meta.url)),
      'utf-8',
    );
    // Only comments should reference TRUNCATE (documenting removal).
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const codeSrc = codeLines.join('\n');
    expect(codeSrc).not.toMatch(/client\.query\(['"]TRUNCATE/);
    expect(codeSrc).not.toMatch(/client\.query\(['"]DELETE FROM entities/);
    expect(codeSrc).not.toMatch(/client\.query\(['"]DELETE FROM entity_snapshots/);
  });

  it('uses ON CONFLICT DO NOTHING for snapshot-bound inserts (idempotency)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-runtime-substrates.ts', import.meta.url)),
      'utf-8',
    );
    // Migration 016: composite PK conflict targets. Single-column
    // `ON CONFLICT (alias_id)` / `(registry_id)` became invalid once the
    // tables' PKs moved to (search_snapshot_id, <id>).
    expect(src).toMatch(/ON CONFLICT \(search_snapshot_id, alias_id\) DO NOTHING/);
    expect(src).toMatch(/ON CONFLICT \(search_snapshot_id, registry_id\) DO NOTHING/);
    expect(src).toMatch(/ON CONFLICT \(search_snapshot_id, entity_id\) DO NOTHING/);
  });
});

describe('T-010 publish-search-snapshot pointer promote wiring', () => {
  it('publish run() calls pointer promote before runtime substrate promotion and live verify', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-search-snapshot.ts', import.meta.url)),
      'utf-8',
    );
    const pointerIdx = src.indexOf('promoteActiveSearchSnapshotPointer(');
    const runtimePromoteIdx = src.indexOf('promoteRuntimeSubstrateArtifacts({');
    const liveVerifyIdx = src.indexOf('runtimeStatePath: args.runtimeStatePath');
    expect(pointerIdx).toBeGreaterThan(0);
    expect(runtimePromoteIdx).toBeGreaterThan(0);
    expect(liveVerifyIdx).toBeGreaterThan(0);
    expect(pointerIdx).toBeLessThan(runtimePromoteIdx);
    expect(runtimePromoteIdx).toBeLessThan(liveVerifyIdx);
    expect(src).toContain('requirePointerParity: false');
    expect(src).toContain('requirePointerParity: true');
  });

  it('rollback path calls rollbackActiveSearchSnapshotPointer first', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-search-snapshot.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/rollbackActiveSearchSnapshotPointer\(\)/);
    // rollback function must reference pointer rollback in the body.
    const rollbackFnStart = src.indexOf('async function rollbackToPreviousSnapshot');
    const rollbackFnEnd = src.indexOf('async function ', rollbackFnStart + 1);
    const rollbackBody = src.slice(rollbackFnStart, rollbackFnEnd);
    expect(rollbackBody).toContain('rollbackActiveSearchSnapshotPointer');
  });

  it('rollback path is gated by pointerPromoted state', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-search-snapshot.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toContain('type SnapshotPublishPhase');
    expect(src).toContain('let pointerPromoted = false');
    expect(src).toContain('pointerPromoted = true');
    expect(src).toContain('if (args.pointerPromoted)');
    expect(src).toContain("publishPhase = 'pointer_promoted'");
  });

  it('runtime substrate promotion rewrites nl mappings path before active promotion', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-runtime-substrates.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toContain('nlMappingsRuntimePath: args.activeRuntimeNlMappingsPath');
    expect(src).toContain('restoreRuntimeSubstrateArtifacts');
    const rewriteIdx = src.indexOf('nlMappingsRuntimePath: args.activeRuntimeNlMappingsPath');
    const promoteIdx = src.indexOf('promoteStagedFile(args.stagedRuntimeNlMappingsPath, args.activeRuntimeNlMappingsPath)');
    expect(rewriteIdx).toBeGreaterThan(0);
    expect(promoteIdx).toBeGreaterThan(0);
    expect(rewriteIdx).toBeLessThan(promoteIdx);
  });
});
