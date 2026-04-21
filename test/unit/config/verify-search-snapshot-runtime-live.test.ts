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

function activeLtrHashFromEmptyRows(): string {
  return hashStableJson([]);
}

interface NamespaceSealOverride {
  readonly entitiesViolations?: string;
  readonly canonicalEntitiesViolations?: string;
  readonly aliasesViolations?: string;
  readonly ambiguityRegistryViolations?: string;
  readonly canonicalAmbiguityViolations?: string;
}

interface VespaPayloadSamples {
  readonly red?: Array<Record<string, unknown>>;
  readonly white?: Array<Record<string, unknown>>;
  readonly sparkling?: Array<Record<string, unknown>>;
}

function createPoolMock(overrides?: {
  readonly canonicalAliasJoinCount?: string;
  readonly canonicalAmbiguityTotalCount?: string;
  readonly canonicalIdentityAuthorityCount?: string;
  readonly runtimeWineTypeCounts?: Partial<Record<'red' | 'white' | 'sparkling', string>>;
  readonly totalCounts?: {
    readonly entities?: string;
    readonly aliases?: string;
    readonly ambiguityRegistry?: string;
    readonly activeLtrModels?: string;
  };
  readonly ltrRows?: Array<{
    readonly total_count: string;
    readonly snapshot_count: string;
    readonly query_class: string | null;
    readonly model_version: number | null;
    readonly eval_dataset_version: string | null;
    readonly feature_schema_hash: string | null;
    readonly weights: number[] | null;
    readonly bias: number | null;
  }>;
  readonly ltrFeatureSchemaHashColumn?: boolean;
  readonly namespaceSeal?: NamespaceSealOverride;
}): Pick<Pool, 'query'> {
  const aliasJoin = overrides?.canonicalAliasJoinCount ?? '10';
  const ambiguityTotal = overrides?.canonicalAmbiguityTotalCount ?? '2';
  const identityAuthority = overrides?.canonicalIdentityAuthorityCount ?? '10';
  const seal = {
    entities_violations: overrides?.namespaceSeal?.entitiesViolations ?? '0',
    canonical_entities_violations: overrides?.namespaceSeal?.canonicalEntitiesViolations ?? '0',
    aliases_violations: overrides?.namespaceSeal?.aliasesViolations ?? '0',
    ambiguity_registry_violations: overrides?.namespaceSeal?.ambiguityRegistryViolations ?? '0',
    canonical_ambiguity_violations: overrides?.namespaceSeal?.canonicalAmbiguityViolations ?? '0',
  };
  const runtimeWineTypeCounts = {
    red: overrides?.runtimeWineTypeCounts?.red ?? '4',
    white: overrides?.runtimeWineTypeCounts?.white ?? '3',
    sparkling: overrides?.runtimeWineTypeCounts?.sparkling ?? '3',
  };
  let callIdx = 0;
  return {
    query: vi.fn(async (_text: string, _params?: readonly unknown[]) => {
      if (_text.includes('information_schema.columns')) {
        return { rows: [{ present: overrides?.ltrFeatureSchemaHashColumn ?? true }] };
      }
      const i = callIdx;
      callIdx++;
      switch (i) {
        case 0:
          return {
            rows: [{
              total_count: overrides?.totalCounts?.entities ?? '10',
              snapshot_count: '10',
            }],
          };
        case 1:
          return {
            rows: [{
              total_count: overrides?.totalCounts?.aliases ?? '10',
              snapshot_count: '10',
            }],
          };
        case 2:
          return {
            rows: [{
              total_count: overrides?.totalCounts?.ambiguityRegistry ?? '2',
              snapshot_count: '2',
            }],
          };
        case 3:
          return {
            rows: overrides?.ltrRows ?? makeLtrRows().map((row) => ({
              ...row,
              total_count: overrides?.totalCounts?.activeLtrModels ?? row.total_count,
            })),
          };
        case 4:
          return { rows: [{ c: '10' }] };
        case 5:
          return { rows: [{ c: identityAuthority }] };
        case 6:
          return { rows: [seal] };
        case 7:
          return { rows: [{ c: runtimeWineTypeCounts.red }] };
        case 8:
          return { rows: [{ c: runtimeWineTypeCounts.white }] };
        case 9:
          return { rows: [{ c: runtimeWineTypeCounts.sparkling }] };
        case 10:
          return { rows: [{ c: aliasJoin }] };
        case 11:
          return { rows: [{ c: ambiguityTotal }] };
        default:
          throw new Error(`Unexpected pool.query call index ${i}`);
      }
    }),
  };
}

/**
 * Build a fetch mock returning Vespa responses in the runtime-check order:
 * snapshot doc count, red count, white count, sparkling count,
 * red/white/sparkling payload samples, namespace seal probe.
 */
function mockVespaResponses(args?: {
  readonly snapshotDocCount?: number;
  readonly wineTypeCounts?: Partial<Record<'red' | 'white' | 'sparkling', number>>;
  readonly namespaceSealViolations?: number;
  readonly payloadSamples?: VespaPayloadSamples;
}) {
  const docCount = args?.snapshotDocCount ?? 10;
  const wineTypeCounts = {
    red: args?.wineTypeCounts?.red ?? 4,
    white: args?.wineTypeCounts?.white ?? 3,
    sparkling: args?.wineTypeCounts?.sparkling ?? 3,
  };
  const violations = args?.namespaceSealViolations ?? 0;
  const payloadSamples = {
    red: args?.payloadSamples?.red ?? [{ entity_id: 'red-entity-1', canonical_label: 'Red One', wine_type: 'red' }],
    white: args?.payloadSamples?.white ?? [{ entity_id: 'white-entity-1', canonical_label: 'White One', wine_type: 'white' }],
    sparkling: args?.payloadSamples?.sparkling ?? [{ entity_id: 'sparkling-entity-1', canonical_label: 'Sparkling One', wine_type: 'sparkling' }],
  };
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ root: { fields: { totalCount: docCount } } }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ root: { fields: { totalCount: wineTypeCounts.red } } }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ root: { fields: { totalCount: wineTypeCounts.white } } }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ root: { fields: { totalCount: wineTypeCounts.sparkling } } }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          root: {
            children: payloadSamples.red.map((sample) => ({ fields: sample })),
          },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          root: {
            children: payloadSamples.white.map((sample) => ({ fields: sample })),
          },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          root: {
            children: payloadSamples.sparkling.map((sample) => ({ fields: sample })),
          },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ root: { fields: { totalCount: violations } } }), { status: 200 }),
    );
}

async function buildHappyRuntimeState(overrides?: {
  readonly snapshotId?: string;
  readonly allowMissingLtr?: boolean;
  readonly activeLtrModels?: number;
  readonly activeLtrHash?: string;
}): Promise<LoadedSearchSnapshotRuntimeState> {
  const dir = await makeTempDir();
  const nlPath = path.join(dir, 'nl.json');
  const nlPayload = { mappings: [{ key: 'a', canonical: 'b' }] };
  await fs.writeFile(nlPath, JSON.stringify(nlPayload));
  const activeLtrHash = activeLtrHashFromRows();
  return {
    schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
    snapshotId: overrides?.snapshotId ?? 'snap-test-1',
    contentHash: 'hash',
    publishedAt: '2026-04-12T00:00:00.000Z',
    manifestPath: '/tmp/m.json',
    nlMappingsRuntimePath: nlPath,
    allowMissingLtr: overrides?.allowMissingLtr ?? false,
    counts: {
      entities: 10,
      aliases: 10,
      ambiguityRegistry: 2,
      nlMappings: 1,
      activeLtrModels: overrides?.activeLtrModels ?? 1,
    },
    hashes: {
      entities: 'entities',
      aliases: 'aliases',
      ambiguityRegistry: 'ambiguity',
      nlMappings: hashRuntimeNlMappings(nlPayload),
      activeLtrModels: overrides?.activeLtrHash ?? activeLtrHash,
    },
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

    const fetchSpy = mockVespaResponses();

    try {
      const pool = createPoolMock() as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).resolves.toMatchObject({ snapshotId: 'snap-test-1' });
      expect(pool.query).toHaveBeenCalledTimes(13);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('passes when active LTR rows are absent and runtime explicitly allows missing LTR', async () => {
    const dir = await makeTempDir();
    const nlPath = path.join(dir, 'nl.json');
    const nlPayload = { mappings: [{ key: 'a', canonical: 'b' }] };
    await fs.writeFile(nlPath, JSON.stringify(nlPayload));

    const runtimeState: LoadedSearchSnapshotRuntimeState = {
      schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
      snapshotId: 'snap-test-1',
      contentHash: 'hash',
      publishedAt: '2026-04-12T00:00:00.000Z',
      manifestPath: '/tmp/m.json',
      nlMappingsRuntimePath: nlPath,
      allowMissingLtr: true,
      counts: {
        entities: 10,
        aliases: 10,
        ambiguityRegistry: 2,
        nlMappings: 1,
        activeLtrModels: 0,
      },
      hashes: {
        entities: 'entities',
        aliases: 'aliases',
        ambiguityRegistry: 'ambiguity',
        nlMappings: hashRuntimeNlMappings(nlPayload),
        activeLtrModels: activeLtrHashFromEmptyRows(),
      },
    };

    const fetchSpy = mockVespaResponses();

    try {
      const pool = createPoolMock({ ltrRows: [] }) as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).resolves.toMatchObject({ snapshotId: 'snap-test-1' });
      expect(pool.query).toHaveBeenCalledTimes(13);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('passes when append-only tables retain older snapshot rows outside the active snapshot', async () => {
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

    const fetchSpy = mockVespaResponses();

    try {
      const pool = createPoolMock({
        totalCounts: {
          entities: '14315',
          aliases: '96548',
          ambiguityRegistry: '7919',
          activeLtrModels: '5',
        },
      }) as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).resolves.toMatchObject({ snapshotId: 'snap-test-1' });
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

    const fetchSpy = mockVespaResponses();

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

  it('throws when canonical_identity_authority does not match runtime entity count', async () => {
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

    const fetchSpy = mockVespaResponses();

    try {
      const pool = createPoolMock({ canonicalIdentityAuthorityCount: '9' }) as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).rejects.toThrow(/Canonical identity authority mismatch/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  describe('ADR-007 namespace seal expansion', () => {
    async function buildHappyState(): Promise<LoadedSearchSnapshotRuntimeState> {
      const dir = await makeTempDir();
      const nlPath = path.join(dir, 'nl.json');
      const nlPayload = { mappings: [{ key: 'a', canonical: 'b' }] };
      await fs.writeFile(nlPath, JSON.stringify(nlPayload));
      const activeLtrHash = activeLtrHashFromRows();
      return {
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
    }

    const planes: ReadonlyArray<{
      readonly label: string;
      readonly override: NamespaceSealOverride;
      readonly expectedDetail: RegExp;
    }> = [
      {
        label: 'entities',
        override: { entitiesViolations: '3' },
        expectedDetail: /entities=3/,
      },
      {
        label: 'canonical_entities',
        override: { canonicalEntitiesViolations: '5' },
        expectedDetail: /canonical_entities=5/,
      },
      {
        label: 'aliases',
        override: { aliasesViolations: '7' },
        expectedDetail: /aliases=7/,
      },
      {
        label: 'ambiguity_registry',
        override: { ambiguityRegistryViolations: '2' },
        expectedDetail: /ambiguity_registry=2/,
      },
      {
        label: 'canonical_ambiguity_registry',
        override: { canonicalAmbiguityViolations: '1' },
        expectedDetail: /canonical_ambiguity_registry=1/,
      },
    ];

    for (const plane of planes) {
      it(`throws when ${plane.label} contains source-style ids`, async () => {
        const runtimeState = await buildHappyState();
        const fetchSpy = mockVespaResponses();
        try {
          const pool = createPoolMock({ namespaceSeal: plane.override }) as unknown as Pool;
          await expect(
            verifySearchSnapshotRuntimeStateLive({
              pool,
              vespaUrl: 'http://vespa.test:8080',
              runtimeState,
            }),
          ).rejects.toThrow(plane.expectedDetail);
        } finally {
          fetchSpy.mockRestore();
        }
      });
    }

    it('throws when Vespa contains documents under the source-record namespace', async () => {
      const runtimeState = await buildHappyState();
      const fetchSpy = mockVespaResponses({ namespaceSealViolations: 3 });
      try {
        const pool = createPoolMock() as unknown as Pool;
        await expect(
          verifySearchSnapshotRuntimeStateLive({
            pool,
            vespaUrl: 'http://vespa.test:8080',
            runtimeState,
          }),
        ).rejects.toThrow(/Vespa contains 3 document/);
      } finally {
        fetchSpy.mockRestore();
      }
    });
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

    const fetchSpy = mockVespaResponses();

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

  it('throws when Vespa document count does not exactly match runtime entity count', async () => {
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

    const fetchSpy = mockVespaResponses({ snapshotDocCount: 9 });

    try {
      const pool = createPoolMock() as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).rejects.toThrow(/Vespa snapshot document count mismatch/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when runtime snapshot is missing a critical wine_type family', async () => {
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

    const fetchSpy = mockVespaResponses();

    try {
      const pool = createPoolMock({ runtimeWineTypeCounts: { sparkling: '0' } }) as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).rejects.toThrow(/Critical wine_type runtime coverage missing.*sparkling/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('throws when Vespa snapshot is missing a critical wine_type family', async () => {
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

    const fetchSpy = mockVespaResponses({ wineTypeCounts: { white: 0 } });

    try {
      const pool = createPoolMock() as unknown as Pool;
      await expect(
        verifySearchSnapshotRuntimeStateLive({
          pool,
          vespaUrl: 'http://vespa.test:8080',
          runtimeState,
        }),
      ).rejects.toThrow(/Critical wine_type Vespa coverage missing.*white/);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  describe('Vespa payload integrity probe', () => {
    it('passes when red/white/sparkling payload hits include required fields', async () => {
      const runtimeState = await buildHappyRuntimeState();
      const fetchSpy = mockVespaResponses();

      try {
        const pool = createPoolMock() as unknown as Pool;
        await expect(
          verifySearchSnapshotRuntimeStateLive({
            pool,
            vespaUrl: 'http://vespa.test:8080',
            runtimeState,
          }),
        ).resolves.toMatchObject({ snapshotId: 'snap-test-1' });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('throws when payload sample misses required canonical field', async () => {
      const runtimeState = await buildHappyRuntimeState();
      const fetchSpy = mockVespaResponses({
        payloadSamples: {
          white: [{ entity_id: 'white-entity-1', wine_type: 'white' }],
        },
      });

      try {
        const pool = createPoolMock() as unknown as Pool;
        await expect(
          verifySearchSnapshotRuntimeStateLive({
            pool,
            vespaUrl: 'http://vespa.test:8080',
            runtimeState,
          }),
        ).rejects.toThrow(/critical wine_type Vespa payload requirement violations/i);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('throws when payload sample has anchor mismatch', async () => {
      const runtimeState = await buildHappyRuntimeState();
      const fetchSpy = mockVespaResponses({
        payloadSamples: {
          sparkling: [{ entity_id: 'sparkling-entity-1', canonical_label: 'Sparkling One', wine_type: 'white' }],
        },
      });

      try {
        const pool = createPoolMock() as unknown as Pool;
        await expect(
          verifySearchSnapshotRuntimeStateLive({
            pool,
            vespaUrl: 'http://vespa.test:8080',
            runtimeState,
          }),
        ).rejects.toThrow(/critical wine_type Vespa payload requirement violations/i);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('accepts legacy ltr_model_registry schemas without feature_schema_hash in no-LTR mode', async () => {
      const runtimeState = await buildHappyRuntimeState({
        snapshotId: 'snap-legacy',
        allowMissingLtr: true,
        activeLtrModels: 0,
        activeLtrHash: activeLtrHashFromEmptyRows(),
      });
      const fetchSpy = mockVespaResponses();

      try {
        const pool = createPoolMock({
          totalCounts: { activeLtrModels: '0' },
          ltrRows: [{
            total_count: '0',
            snapshot_count: '0',
            query_class: null,
            model_version: null,
            eval_dataset_version: null,
            feature_schema_hash: null,
            weights: null,
            bias: null,
          }],
          ltrFeatureSchemaHashColumn: false,
        }) as unknown as Pool;
        await expect(
          verifySearchSnapshotRuntimeStateLive({
            pool,
            vespaUrl: 'http://vespa.test:8080',
            runtimeState,
          }),
        ).resolves.toMatchObject({ snapshotId: 'snap-legacy', allowMissingLtr: true });
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
