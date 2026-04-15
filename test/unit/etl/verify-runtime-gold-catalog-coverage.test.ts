import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import { verifyRuntimeGoldCatalogCoverage } from '../../../scripts/etl/verify-runtime-gold-catalog-coverage.js';

interface FixtureSpec {
  readonly canonicalEntities: ReadonlyArray<{
    readonly entity_id: string;
    readonly canonical_label: string;
    readonly vintage: number | null;
  }>;
  readonly targetMap: Record<string, string | null>;
}

async function makeFixtureRepo(spec: FixtureSpec): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-runtime-gold-'));
  const goldensDir = path.join(root, 'goldens');
  await fs.mkdir(goldensDir, { recursive: true });
  await fs.writeFile(
    path.join(goldensDir, 'canonical-entities.json'),
    JSON.stringify({ entities: spec.canonicalEntities }),
  );
  await fs.writeFile(
    path.join(goldensDir, 'target-entity-map.json'),
    JSON.stringify({ map: spec.targetMap }),
  );
  return root;
}

interface RuntimeFakePoolSpec {
  readonly runtimeRows: ReadonlyArray<{
    readonly entity_id: string;
    readonly benchmark_entity_id: string | null;
  }>;
  readonly canonicalRows: ReadonlyArray<{
    readonly canonical_entity_id: string;
    readonly benchmark_entity_id: string | null;
  }>;
  readonly identityParityRows: ReadonlyArray<{
    readonly entity_id: string;
    readonly runtime_signature: string;
    readonly authority_signature: string | null;
    readonly authority_entity_id: string | null;
  }>;
  readonly benchmarkParityRows?: ReadonlyArray<{
    readonly entity_id: string;
    readonly runtime_benchmark_entity_id: string | null;
    readonly canonical_benchmark_entity_id: string | null;
  }>;
}

function fakePool(spec: RuntimeFakePoolSpec): Pool {
  let callIdx = 0;
  return {
    query: vi.fn(async (_text: string, params?: readonly unknown[]) => {
      const requested = (params?.[1] ?? params?.[0] ?? []) as readonly string[];
      const i = callIdx;
      callIdx++;
      if (i === 0) {
        const rows = spec.runtimeRows.filter((row) =>
          requested.includes(row.entity_id) || (row.benchmark_entity_id != null && requested.includes(row.benchmark_entity_id)));
        return { rows };
      }
      if (i === 1) {
        const rows = spec.canonicalRows.filter((row) =>
          requested.includes(row.canonical_entity_id) || (row.benchmark_entity_id != null && requested.includes(row.benchmark_entity_id)));
        return { rows };
      }
      if (i === 2) {
        const rows = spec.benchmarkParityRows ?? spec.runtimeRows.map((row) => ({
          entity_id: row.entity_id,
          runtime_benchmark_entity_id: row.benchmark_entity_id,
          canonical_benchmark_entity_id: row.benchmark_entity_id,
        }));
        return { rows };
      }
      if (i === 3) {
        // T-011/W3: identity_signature parity query. Return matched
        // signatures so parity passes by default in existing happy-path
        // tests. Tests that want to exercise drift override this pool.
        return { rows: spec.identityParityRows };
      }
      throw new Error(`Unexpected pool.query call index ${i}`);
    }),
  } as unknown as Pool;
}

describe('verifyRuntimeGoldCatalogCoverage (ADR-007 cutover gate)', () => {
  it('passes when every required canonical id is present in entities and canonical_entities', async () => {
    const fixtureRoot = await makeFixtureRepo({
      canonicalEntities: [
        { entity_id: 'opus-one-2018', canonical_label: 'Opus One', vintage: 2018 },
        { entity_id: 'sassicaia-2017', canonical_label: 'Sassicaia', vintage: 2017 },
      ],
      targetMap: {
        'case-1': 'opus-one-2018',
        'case-2': 'sassicaia-2017',
        'case-3': null,
      },
    });
    const pool = fakePool({
      runtimeRows: [
        { entity_id: 'opus-one-2018', benchmark_entity_id: 'opus-one-2018' },
        { entity_id: 'sassicaia-2017', benchmark_entity_id: 'sassicaia-2017' },
      ],
      canonicalRows: [
        { canonical_entity_id: 'opus-one-2018', benchmark_entity_id: 'opus-one-2018' },
        { canonical_entity_id: 'sassicaia-2017', benchmark_entity_id: 'sassicaia-2017' },
      ],
      identityParityRows: [
        {
          entity_id: 'opus-one-2018',
          runtime_signature: 'sig-opus',
          authority_signature: 'sig-opus',
          authority_entity_id: 'opus-one-2018',
        },
        {
          entity_id: 'sassicaia-2017',
          runtime_signature: 'sig-sass',
          authority_signature: 'sig-sass',
          authority_entity_id: 'sassicaia-2017',
        },
      ],
    });
    const result = await verifyRuntimeGoldCatalogCoverage({
      pool,
      snapshotId: 'snap-test-1',
      fixtureRepoRoot: fixtureRoot,
    });
    expect(result.requiredCanonicalIds).toBe(2);
    expect(result.runtimePublicIdMatches).toBe(2);
    expect(result.runtimeBenchmarkLinkageMatches).toBe(2);
    expect(result.canonicalPublicIdMatches).toBe(2);
    expect(result.canonicalBenchmarkLinkageMatches).toBe(2);
    expect(result.missingFromEntities).toEqual([]);
    expect(result.missingFromCanonicalEntities).toEqual([]);
  });

  it('fails when a required id is missing from runtime entities for the active snapshot', async () => {
    const fixtureRoot = await makeFixtureRepo({
      canonicalEntities: [
        { entity_id: 'opus-one-2018', canonical_label: 'Opus One', vintage: 2018 },
      ],
      targetMap: { 'case-1': 'opus-one-2018' },
    });
    const pool = fakePool({
      runtimeRows: [],
      canonicalRows: [
        { canonical_entity_id: 'opus-one-2018', benchmark_entity_id: 'opus-one-2018' },
      ],
      identityParityRows: [],
    });
    await expect(
      verifyRuntimeGoldCatalogCoverage({
        pool,
        snapshotId: 'snap-test-1',
        fixtureRepoRoot: fixtureRoot,
      }),
    ).rejects.toThrow(/entities \(snapshot=snap-test-1\) missing 1 runtime\/public-linkage id\(s\): opus-one-2018/);
  });

  it('fails when a required id is missing from canonical_entities graph plane', async () => {
    const fixtureRoot = await makeFixtureRepo({
      canonicalEntities: [
        { entity_id: 'opus-one-2018', canonical_label: 'Opus One', vintage: 2018 },
      ],
      targetMap: { 'case-1': 'opus-one-2018' },
    });
    const pool = fakePool({
      runtimeRows: [
        { entity_id: 'opus-one-2018', benchmark_entity_id: 'opus-one-2018' },
      ],
      canonicalRows: [],
      identityParityRows: [
        {
          entity_id: 'opus-one-2018',
          runtime_signature: 'sig-opus',
          authority_signature: null,
          authority_entity_id: null,
        },
      ],
    });
    await expect(
      verifyRuntimeGoldCatalogCoverage({
        pool,
        snapshotId: 'snap-test-1',
        fixtureRepoRoot: fixtureRoot,
      }),
    ).rejects.toThrow(/canonical_entities missing 1 runtime\/public-linkage id\(s\): opus-one-2018/);
  });

  it('fails when target-entity-map references a source-style id', async () => {
    const fixtureRoot = await makeFixtureRepo({
      canonicalEntities: [
        { entity_id: 'opus-one-2018', canonical_label: 'Opus One', vintage: 2018 },
      ],
      targetMap: { 'case-1': 'vivino-12345' },
    });
    const pool = fakePool({
      runtimeRows: [],
      canonicalRows: [],
      identityParityRows: [],
    });
    await expect(
      verifyRuntimeGoldCatalogCoverage({
        pool,
        snapshotId: 'snap-test-1',
        fixtureRepoRoot: fixtureRoot,
      }),
    ).rejects.toThrow(/forbidden source-style id for case-1/);
  });

  it('fails when target-entity-map references an id absent from canonical-entities.json', async () => {
    const fixtureRoot = await makeFixtureRepo({
      canonicalEntities: [
        { entity_id: 'opus-one-2018', canonical_label: 'Opus One', vintage: 2018 },
      ],
      targetMap: { 'case-1': 'undeclared-canonical-id' },
    });
    const pool = fakePool({
      runtimeRows: [],
      canonicalRows: [],
      identityParityRows: [],
    });
    await expect(
      verifyRuntimeGoldCatalogCoverage({
        pool,
        snapshotId: 'snap-test-1',
        fixtureRepoRoot: fixtureRoot,
      }),
    ).rejects.toThrow(/Fixture inconsistent/);
  });

  it('returns zero when target-entity-map has no non-null targets (no DB call required)', async () => {
    const fixtureRoot = await makeFixtureRepo({
      canonicalEntities: [
        { entity_id: 'opus-one-2018', canonical_label: 'Opus One', vintage: 2018 },
      ],
      targetMap: { 'case-1': null, 'case-2': null },
    });
    const pool = fakePool({
      runtimeRows: [],
      canonicalRows: [],
      identityParityRows: [],
    });
    const result = await verifyRuntimeGoldCatalogCoverage({
      pool,
      snapshotId: 'snap-test-1',
      fixtureRepoRoot: fixtureRoot,
    });
    expect(result.requiredCanonicalIds).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('fails when runtime benchmark linkage drifts from canonical benchmark linkage', async () => {
    const fixtureRoot = await makeFixtureRepo({
      canonicalEntities: [
        { entity_id: 'opus-one-2018', canonical_label: 'Opus One', vintage: 2018 },
      ],
      targetMap: { 'case-1': 'opus-one-2018' },
    });
    const pool = fakePool({
      runtimeRows: [
        { entity_id: 'opus-one-2018', benchmark_entity_id: 'opus-one-2018' },
      ],
      canonicalRows: [
        { canonical_entity_id: 'opus-one-2018', benchmark_entity_id: 'opus-one-2018-drift' },
      ],
      benchmarkParityRows: [
        {
          entity_id: 'opus-one-2018',
          runtime_benchmark_entity_id: 'opus-one-2018',
          canonical_benchmark_entity_id: 'opus-one-2018-drift',
        },
      ],
      identityParityRows: [
        {
          entity_id: 'opus-one-2018',
          runtime_signature: 'sig-opus',
          authority_signature: 'sig-opus',
          authority_entity_id: 'opus-one-2018',
        },
      ],
    });
    await expect(
      verifyRuntimeGoldCatalogCoverage({
        pool,
        snapshotId: 'snap-test-1',
        fixtureRepoRoot: fixtureRoot,
      }),
    ).rejects.toThrow(/Benchmark linkage drift/);
  });

  it('fails when runtime identity authority drifts from canonical_identity_authority', async () => {
    const fixtureRoot = await makeFixtureRepo({
      canonicalEntities: [
        { entity_id: 'opus-one-2018', canonical_label: 'Opus One', vintage: 2018 },
      ],
      targetMap: { 'case-1': 'opus-one-2018' },
    });
    const pool = fakePool({
      runtimeRows: [
        { entity_id: 'opus-one-2018', benchmark_entity_id: 'opus-one-2018' },
      ],
      canonicalRows: [
        { canonical_entity_id: 'opus-one-2018', benchmark_entity_id: 'opus-one-2018' },
      ],
      identityParityRows: [
        {
          entity_id: 'opus-one-2018',
          runtime_signature: 'sig-opus',
          authority_signature: 'sig-opus',
          authority_entity_id: 'opus-one-2019',
        },
      ],
    });
    await expect(
      verifyRuntimeGoldCatalogCoverage({
        pool,
        snapshotId: 'snap-test-1',
        fixtureRepoRoot: fixtureRoot,
      }),
    ).rejects.toThrow(/Identity authority drift/);
  });
});
