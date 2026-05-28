/**
 * T-010/W2: read-path adapters scope queries by active snapshot pointer.
 *
 * Contract:
 *  - adapters resolve active_snapshot_id via ActiveSnapshotResolver
 *  - missing pointer table (42P01) only degrades under the explicit bootstrap seam
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

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
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

  it('negative-caches 42P01 within the TTL window but bypassCache still forces a real SELECT', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T00:00:00Z'));
    try {
      const err = new Error('relation "active_search_snapshot" does not exist') as Error & { code: string };
      err.code = '42P01';
      const pool = {
        query: vi.fn().mockRejectedValue(err),
      } as unknown as import('pg').Pool;

      await expect(resolveActiveSnapshot(pool)).rejects.toMatchObject({ code: '42P01' });
      await expect(resolveActiveSnapshot(pool)).rejects.toMatchObject({ code: '42P01' });
      expect((pool.query as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);

      await expect(resolveActiveSnapshot(pool, { bypassCache: true }))
        .rejects.toMatchObject({ code: '42P01' });
      expect((pool.query as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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

describe('T-010/W2 snapshot substrate bootstrap seam', () => {
  it('PgBlockingAdapter fails closed on 42P01 in production unless bootstrap is explicit', async () => {
    await withEnv({ NODE_ENV: 'production', WINE_ENGINE_BOOTSTRAP_ACTIVE_SNAPSHOT_SUBSTRATE: undefined }, async () => {
      const { PgBlockingAdapter } = await import('../../src/infrastructure/adapter/pg-blocking-adapter.js');
      const err = new Error('relation "active_search_snapshot" does not exist') as Error & { code: string };
      err.code = '42P01';
      const pool = {
        query: vi.fn().mockRejectedValue(err),
      } as unknown as import('pg').Pool;
      const adapter = new PgBlockingAdapter(pool);

      await expect(adapter.block('Opus One', 'opus one')).rejects.toMatchObject({ code: '42P01' });
    });
  });

  it('PgBlockingAdapter allows bootstrap degradation only under the explicit seam', async () => {
    await withEnv({ NODE_ENV: 'production', WINE_ENGINE_BOOTSTRAP_ACTIVE_SNAPSHOT_SUBSTRATE: '1' }, async () => {
      const { PgBlockingAdapter } = await import('../../src/infrastructure/adapter/pg-blocking-adapter.js');
      const err = new Error('relation "active_search_snapshot" does not exist') as Error & { code: string };
      err.code = '42P01';
      const pool = {
        query: vi.fn().mockRejectedValue(err),
      } as unknown as import('pg').Pool;
      const adapter = new PgBlockingAdapter(pool);

      await expect(adapter.block('Opus One', 'opus one')).resolves.toEqual([]);
    });
  });

  it('PgAliasMatcher fails closed on 42P01 in production unless bootstrap is explicit', async () => {
    await withEnv({ NODE_ENV: 'production', WINE_ENGINE_BOOTSTRAP_ACTIVE_SNAPSHOT_SUBSTRATE: undefined }, async () => {
      const { PgAliasMatcher } = await import('../../src/infrastructure/adapter/pg-alias-matcher.js');
      const err = new Error('relation "active_search_snapshot" does not exist') as Error & { code: string };
      err.code = '42P01';
      const pool = {
        query: vi.fn().mockRejectedValue(err),
      } as unknown as import('pg').Pool;
      const matcher = new PgAliasMatcher(pool);

      await expect(matcher.findMatches('beaujolais nouveau')).rejects.toMatchObject({ code: '42P01' });
    });
  });

  it('PgAmbiguityDictionary fails closed on 42P01 in production unless bootstrap is explicit', async () => {
    await withEnv({ NODE_ENV: 'production', WINE_ENGINE_BOOTSTRAP_ACTIVE_SNAPSHOT_SUBSTRATE: undefined }, async () => {
      const { PgAmbiguityDictionary } = await import('../../src/infrastructure/adapter/pg-ambiguity-dictionary.js');
      const err = new Error('relation "active_search_snapshot" does not exist') as Error & { code: string };
      err.code = '42P01';
      const pool = {
        query: vi.fn().mockRejectedValue(err),
      } as unknown as import('pg').Pool;
      const dictionary = new PgAmbiguityDictionary(pool);

      await expect(dictionary.isKnownAmbiguous('bordeaux')).rejects.toMatchObject({ code: '42P01' });
    });
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
    // The runtime-readiness probe + its `requirePointerParity` opt-in moved
    // out of `src/config/readiness.ts` and into the infrastructure health
    // module that now owns the search-snapshot probe. The opt-in invariant is
    // preserved — just the file home moved.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/health/search-snapshot-readiness.ts', import.meta.url)),
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
