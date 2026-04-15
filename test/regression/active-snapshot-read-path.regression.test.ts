/**
 * T-010/W2: read-path adapters scope queries by active snapshot pointer.
 *
 * Contract:
 *  - adapters resolve active_snapshot_id via ActiveSnapshotResolver
 *  - missing pointer table (42P01) degrades to empty result (dev bootstrap)
 *  - present-but-empty pointer row is loud (publish never ran)
 *  - each read query carries search_snapshot_id as a bound parameter
 */
import { describe, expect, it, vi } from 'vitest';
import { resolveActiveSnapshot, NoActiveSnapshotPointerError } from '../../src/infrastructure/db/active-snapshot-resolver.js';

function makePool(rows: unknown[]) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as import('pg').Pool;
}

describe('T-010/W2 resolveActiveSnapshot', () => {
  it('returns activeSnapshotId when pointer row is present', async () => {
    const pool = makePool([{
      active_snapshot_id: 'snap-abc',
      previous_snapshot_id: 'snap-prev',
      content_hash: 'hash-1',
      promoted_at: new Date('2026-04-14T00:00:00Z'),
    }]);
    const result = await resolveActiveSnapshot(pool, { bypassCache: true });
    expect(result.activeSnapshotId).toBe('snap-abc');
    expect(result.previousSnapshotId).toBe('snap-prev');
  });

  it('throws NoActiveSnapshotPointerError when row is missing', async () => {
    const pool = makePool([]);
    await expect(resolveActiveSnapshot(pool, { bypassCache: true }))
      .rejects.toBeInstanceOf(NoActiveSnapshotPointerError);
  });

  it('propagates 42P01 (table missing) unchanged so adapters can degrade', async () => {
    const err = new Error('relation "active_search_snapshot" does not exist') as Error & { code: string };
    err.code = '42P01';
    const pool = {
      query: vi.fn().mockRejectedValue(err),
    } as unknown as import('pg').Pool;
    await expect(resolveActiveSnapshot(pool, { bypassCache: true }))
      .rejects.toMatchObject({ code: '42P01' });
  });

  it('caches pointer reads within the TTL window', async () => {
    const pool = makePool([{
      active_snapshot_id: 'snap-cached',
      previous_snapshot_id: null,
      content_hash: 'h',
      promoted_at: new Date(),
    }]);
    await resolveActiveSnapshot(pool);
    await resolveActiveSnapshot(pool);
    await resolveActiveSnapshot(pool);
    // 1 SELECT expected — second/third reads hit the cache.
    expect((pool.query as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it('bypassCache forces a fresh SELECT each time', async () => {
    const pool = makePool([{
      active_snapshot_id: 'snap-fresh',
      previous_snapshot_id: null,
      content_hash: 'h',
      promoted_at: new Date(),
    }]);
    await resolveActiveSnapshot(pool, { bypassCache: true });
    await resolveActiveSnapshot(pool, { bypassCache: true });
    expect((pool.query as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});

describe('T-010/W2 adapter SQL contract — snapshot_id binding', () => {
  it('pg-alias-matcher SQL filters by search_snapshot_id', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/adapter/pg-alias-matcher.ts', import.meta.url)),
      'utf-8',
    );
    // All FROM aliases queries must carry search_snapshot_id
    const fromAliasCount = (src.match(/FROM aliases/g) ?? []).length;
    const snapshotFilterCount = (src.match(/search_snapshot_id = \$\d/g) ?? []).length;
    expect(fromAliasCount).toBeGreaterThan(0);
    expect(snapshotFilterCount).toBeGreaterThanOrEqual(fromAliasCount);
  });

  it('pg-ambiguity-dictionary SQL filters by search_snapshot_id', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/adapter/pg-ambiguity-dictionary.ts', import.meta.url)),
      'utf-8',
    );
    const fromCount = (src.match(/FROM ambiguity_registry/g) ?? []).length;
    const snapshotFilterCount = (src.match(/search_snapshot_id = \$\d/g) ?? []).length;
    expect(fromCount).toBeGreaterThan(0);
    expect(snapshotFilterCount).toBeGreaterThanOrEqual(fromCount);
  });

  it('pg-blocking-adapter SQL filters by search_snapshot_id', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/adapter/pg-blocking-adapter.ts', import.meta.url)),
      'utf-8',
    );
    const fromCount = (src.match(/FROM aliases/g) ?? []).length;
    const snapshotFilterCount = (src.match(/search_snapshot_id = \$\d/g) ?? []).length;
    expect(fromCount).toBeGreaterThan(0);
    expect(snapshotFilterCount).toBeGreaterThanOrEqual(fromCount);
  });

  it('pg-alias-repository SQL filters by search_snapshot_id', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/adapter/pg-alias-repository.ts', import.meta.url)),
      'utf-8',
    );
    const selectCount = (src.match(/SELECT \* FROM aliases/g) ?? []).length;
    const snapshotFilterCount = (src.match(/search_snapshot_id = \$\d/g) ?? []).length;
    expect(selectCount).toBeGreaterThan(0);
    expect(snapshotFilterCount).toBeGreaterThanOrEqual(selectCount);
  });

  it('pg-entity-repository SQL filters entity reads by search_snapshot_id', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/adapter/pg-entity-repository.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/resolveActiveSnapshot/);
    expect(src).toMatch(/SELECT \* FROM entities WHERE entity_id = \$1 AND search_snapshot_id = \$2/);
    expect(src).toMatch(/SELECT \* FROM entities WHERE identity_signature = \$1 AND search_snapshot_id = \$2/);
    expect(src).toMatch(/SELECT \* FROM entities WHERE entity_type = \$1 AND search_snapshot_id = \$2/);
  });
});

describe('T-010/W2 readiness pointer-aware', () => {
  it('requirePointerParity option is wired into verifySearchSnapshotRuntimeStateLive', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/health/search-snapshot-readiness.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/requirePointerParity/);
    expect(src).toMatch(/FROM active_search_snapshot WHERE id = 1/);
    expect(src).toMatch(/pointer\/runtime-state drift/);
  });

  it('readiness probe opts into pointer parity', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/config/readiness.ts', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/requirePointerParity: true/);
  });

  it('publish re-verifies readiness with pointer parity after promote', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/etl/publish-search-snapshot.ts', import.meta.url)),
      'utf-8',
    );
    // The second verify call uses requirePointerParity: true and is AFTER promoteActiveSearchSnapshotPointer.
    const promoteIdx = src.indexOf('promoteActiveSearchSnapshotPointer(');
    const reverifyIdx = src.indexOf('requirePointerParity: true');
    expect(promoteIdx).toBeGreaterThan(0);
    expect(reverifyIdx).toBeGreaterThan(promoteIdx);
  });
});
