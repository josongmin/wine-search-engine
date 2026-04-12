import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { getCurrentFeatureSchemaHash } from '../../../src/domain/ranking/service/feature-parity-hash.js';
import {
  verifySearchSnapshotRuntimeStateLive,
  type LoadedSearchSnapshotRuntimeState,
} from '../../../src/infrastructure/health/search-snapshot-readiness.js';
import { SEARCH_SNAPSHOT_STATE_VERSION } from '../../../src/shared/constants/search-snapshot.js';
import { hashStableJson, hashText, stableJsonStringify } from '../../../src/shared/utils/stable-json.js';

function hashRuntimeNlMappings(payload: unknown): string {
  return hashText(`${stableJsonStringify(payload)}\n`);
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'verify-snapshot-live-'));
}

function makeLtrRows(): Array<{
  total_count: string;
  snapshot_count: string;
  query_class: string | null;
  model_version: number | null;
  eval_dataset_version: string | null;
  feature_schema_hash: string | null;
  weights: number[] | null;
  bias: number | null;
}> {
  const featureHash = getCurrentFeatureSchemaHash();
  return [
    {
      total_count: '1',
      snapshot_count: '1',
      query_class: 'retrieve',
      model_version: 1,
      eval_dataset_version: 'fixture-v1',
      feature_schema_hash: featureHash,
      weights: [0.1, 0.2],
      bias: 0,
    },
  ];
}

function activeLtrHashFromRows(): string {
  const rows = makeLtrRows();
  return hashStableJson(
    rows
      .filter((row) => row.query_class !== null)
      .map((row) => ({
        query_class: row.query_class,
        model_version: row.model_version,
        eval_dataset_version: row.eval_dataset_version,
        feature_schema_hash: row.feature_schema_hash,
        weights: row.weights,
        bias: row.bias,
      })),
  );
}

function createPoolMock(overrides?: {
  readonly canonicalAliasJoinCount?: string;
  readonly canonicalAmbiguityTotalCount?: string;
}): Pick<Pool, 'query'> {
  const aliasJoin = overrides?.canonicalAliasJoinCount ?? '10';
  const ambiguityTotal = overrides?.canonicalAmbiguityTotalCount ?? '2';
  let callIdx = 0;
  return {
    query: vi.fn(async (_text: string, _params?: readonly unknown[]) => {
      const i = callIdx;
      callIdx++;
      switch (i) {
        case 0:
          return { rows: [{ total_count: '10', snapshot_count: '10' }] };
        case 1:
          return { rows: [{ total_count: '10', snapshot_count: '10' }] };
        case 2:
          return { rows: [{ total_count: '2', snapshot_count: '2' }] };
        case 3:
          return { rows: makeLtrRows() };
        case 4:
          return { rows: [{ c: '10' }] };
        case 5:
          return { rows: [{ c: '0' }] };
        case 6:
          return { rows: [{ c: aliasJoin }] };
        case 7:
          return { rows: [{ c: ambiguityTotal }] };
        default:
          throw new Error(`Unexpected pool.query call index ${i}`);
      }
    }),
  };
}

describe('verifySearchSnapshotRuntimeStateLive', () => {
  it('passes when PG counts, canonical projections, NL mappings, LTR, and Vespa align', async () => {
    const dir = await makeTempDir();
    const nlPath = path.join(dir, 'nl.json');
    const nlPayload = { mappings: [{ key: 'a', canonical: 'b' }] };
    await fs.writeFile(nlPath, JSON.stringify(nlPayload));

    const activeLtrHash = activeLtrHashFromRows();
    const runtimeState: LoadedSearchSnapshotRuntimeState = {
      schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
      snapshotId: 'snap-test-1',
      contentHash: 'hash',
      publishedAt: '2026-04-12T00:00:00.000Z',
      manifestPath: '/tmp/m.json',
      nlMappingsRuntimePath: nlPath,
      allowMissingLtr: false,
      counts: {
        entities: 10,
        aliases: 10,
        ambiguityRegistry: 2,
        nlMappings: 1,
        activeLtrModels: 1,
      },
      hashes: {
        entities: 'entities',
        aliases: 'aliases',
        ambiguityRegistry: 'ambiguity',
        nlMappings: hashRuntimeNlMappings(nlPayload),
        activeLtrModels: activeLtrHash,
      },
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ root: { fields: { totalCount: 42 } } }), { status: 200 }),
    );

    try {
      const pool = createPoolMock() as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).resolves.toMatchObject({ snapshotId: 'snap-test-1' });
      expect(pool.query).toHaveBeenCalledTimes(8);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when canonical_ambiguity_registry total does not match runtime ambiguity count', async () => {
    const dir = await makeTempDir();
    const nlPath = path.join(dir, 'nl.json');
    const nlPayload = { mappings: [{ key: 'a', canonical: 'b' }] };
    await fs.writeFile(nlPath, JSON.stringify(nlPayload));

    const activeLtrHash = activeLtrHashFromRows();
    const runtimeState: LoadedSearchSnapshotRuntimeState = {
      schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
      snapshotId: 'snap-test-1',
      contentHash: 'hash',
      publishedAt: '2026-04-12T00:00:00.000Z',
      manifestPath: '/tmp/m.json',
      nlMappingsRuntimePath: nlPath,
      allowMissingLtr: false,
      counts: {
        entities: 10,
        aliases: 10,
        ambiguityRegistry: 2,
        nlMappings: 1,
        activeLtrModels: 1,
      },
      hashes: {
        entities: 'entities',
        aliases: 'aliases',
        ambiguityRegistry: 'ambiguity',
        nlMappings: hashRuntimeNlMappings(nlPayload),
        activeLtrModels: activeLtrHash,
      },
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ root: { fields: { totalCount: 42 } } }), { status: 200 }),
    );

    try {
      const pool = createPoolMock({ canonicalAmbiguityTotalCount: '99' }) as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).rejects.toThrow(/Canonical ambiguity projection mismatch/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when canonical_aliases join count does not match runtime alias count', async () => {
    const dir = await makeTempDir();
    const nlPath = path.join(dir, 'nl.json');
    const nlPayload = { mappings: [{ key: 'a', canonical: 'b' }] };
    await fs.writeFile(nlPath, JSON.stringify(nlPayload));

    const activeLtrHash = activeLtrHashFromRows();
    const runtimeState: LoadedSearchSnapshotRuntimeState = {
      schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
      snapshotId: 'snap-test-1',
      contentHash: 'hash',
      publishedAt: '2026-04-12T00:00:00.000Z',
      manifestPath: '/tmp/m.json',
      nlMappingsRuntimePath: nlPath,
      allowMissingLtr: false,
      counts: {
        entities: 10,
        aliases: 10,
        ambiguityRegistry: 2,
        nlMappings: 1,
        activeLtrModels: 1,
      },
      hashes: {
        entities: 'entities',
        aliases: 'aliases',
        ambiguityRegistry: 'ambiguity',
        nlMappings: hashRuntimeNlMappings(nlPayload),
        activeLtrModels: activeLtrHash,
      },
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ root: { fields: { totalCount: 42 } } }), { status: 200 }),
    );

    try {
      const pool = createPoolMock({ canonicalAliasJoinCount: '9' }) as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).rejects.toThrow(/Canonical alias projection mismatch/);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
