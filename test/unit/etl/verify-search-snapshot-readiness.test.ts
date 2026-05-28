import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEARCH_SNAPSHOT_SCHEMA_VERSION,
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../../src/domain/shared/constants/search-snapshot.js';
import {
  canonicalizeAliasSnapshotRecords,
  canonicalizeAmbiguitySnapshotRows,
  canonicalizeEntitySnapshotRecords,
} from '../../../src/domain/shared/utils/search-snapshot-canonicalization.js';
import { hashStableJson } from '../../../src/domain/shared/utils/stable-json.js';

const {
  mockVerifySearchSnapshotRuntimeStateLive,
  mockCreatePgPool,
} = vi.hoisted(() => ({
  mockVerifySearchSnapshotRuntimeStateLive: vi.fn(),
  mockCreatePgPool: vi.fn(() => ({ end: vi.fn() })),
}));

vi.mock('../../../src/config/env.js', () => ({
  loadConfig: vi.fn(() => ({
    vespa: {
      url: 'http://vespa.test:8080',
      certPath: '/tmp/vespa-cert.pem',
      keyPath: '/tmp/vespa-key.pem',
    },
    pg: { host: 'localhost' },
  })),
}));

vi.mock('../../../src/infrastructure/db/pg-pool.js', () => ({
  createPgPool: mockCreatePgPool,
  shouldUsePgPool: vi.fn(() => true),
}));

vi.mock('../../../src/infrastructure/health/search-snapshot-readiness.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/infrastructure/health/search-snapshot-readiness.js')>(
    '../../../src/infrastructure/health/search-snapshot-readiness.js',
  );
  return {
    ...actual,
    verifySearchSnapshotRuntimeStateLive: mockVerifySearchSnapshotRuntimeStateLive,
  };
});

import { verifySearchSnapshotReadiness } from '../../../scripts/etl/verify-search-snapshot-readiness.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'verify-search-snapshot-readiness-'));
}

async function writeFixtureFiles(args?: {
  readonly runtimeEntities?: number;
  readonly manifestEntities?: number;
  readonly activeLtrModels?: number;
}): Promise<{
  readonly runtimeStatePath: string;
  readonly manifestPath: string;
}> {
  const dir = await makeTempDir();
  const manifestPath = path.join(dir, 'manifest.json');
  const runtimeStatePath = path.join(dir, 'runtime-state.json');
  const nlMappingsPath = path.join(dir, 'nl-mappings.json');
  const entitiesPath = path.join(dir, 'entities.ndjson');
  const aliasesPath = path.join(dir, 'aliases.ndjson');
  const ambiguityPath = path.join(dir, 'ambiguity.ndjson');
  const documentsPath = path.join(dir, 'documents.ndjson');
  const vespaFeedPath = path.join(dir, 'vespa-feed.ndjson');
  const metadataPath = path.join(dir, 'metadata.json');

  const entities = Array.from({ length: args?.manifestEntities ?? 10 }, (_, index) => ({
    entityId: `wine-${index + 1}`,
    entityType: 'wine' as const,
    canonicalLabel: `Wine ${index + 1}`,
    identitySignature: `identity-${index + 1}`,
    relations: {},
    attributes: { wineType: index === 0 ? 'red' : 'white' },
    metadata: {},
  }));
  const aliases = Array.from({ length: 10 }, (_, index) => ({
    aliasId: `alias-${index + 1}`,
    entityId: entities[index % entities.length]!.entityId,
    value: `Alias ${index + 1}`,
    normalizedValue: `alias-${index + 1}`,
    type: 'producer',
    scope: 'global',
    source: 'fixture',
    sourceTrust: 1,
    confidencePrior: 1,
  }));
  const ambiguityRows: {
    readonly registryId: string;
    readonly normalizedForm: string;
    readonly entityIds: readonly string[];
    readonly ambiguityTypes: readonly string[];
    readonly severity: 'low' | 'medium' | 'high';
  }[] = [];
  const entityHash = hashStableJson(canonicalizeEntitySnapshotRecords(entities));
  const aliasHash = hashStableJson(canonicalizeAliasSnapshotRecords(aliases));
  const ambiguityHash = hashStableJson(canonicalizeAmbiguitySnapshotRows(ambiguityRows));

  await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [{ key: 'full-bodied', canonical: 'full_bodied' }] }));
  await fs.writeFile(entitiesPath, `${entities.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await fs.writeFile(aliasesPath, `${aliases.map((row) => JSON.stringify(row)).join('\n')}\n`);
  await fs.writeFile(ambiguityPath, '');
  await fs.writeFile(documentsPath, '');
  await fs.writeFile(vespaFeedPath, '');
  await fs.writeFile(metadataPath, '{}\n');
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-04-14T00:00:00.000Z',
      contentHash: 'content-hash',
      sourceInputPath: '/tmp/silver-trackc.ndjson',
      artifacts: {
        documentsNdjson: documentsPath,
        vespaFeedNdjson: vespaFeedPath,
        entitiesNdjson: entitiesPath,
        aliasesNdjson: aliasesPath,
        ambiguityRegistryNdjson: ambiguityPath,
        nlMappingsJson: nlMappingsPath,
        metadataJson: metadataPath,
      },
      counts: {
        documents: 10,
        vespaFeed: 10,
        entities: args?.manifestEntities ?? 10,
        aliases: 10,
        ambiguityRegistry: 0,
        nlMappings: 1,
      },
      hashes: {
        documents: 'documents-hash',
        vespaFeed: 'vespa-feed-hash',
        entities: entityHash,
        aliases: aliasHash,
        ambiguityRegistry: ambiguityHash,
        nlMappings: 'nl-hash',
      },
      quality: {
        status: 'canonical',
        blockers: [],
        bypasses: [],
        carryForwardBenchmarkCount: 0,
        experimentalInputsPresent: false,
      },
      fieldAvailability: {
        appellation: {
          populatedDocCount: 8,
          totalDocCount: 10,
          populatedDocRatio: 0.8,
        },
        body: {
          populatedDocCount: 6,
          totalDocCount: 10,
          populatedDocRatio: 0.6,
        },
        sweetness: {
          populatedDocCount: 6,
          totalDocCount: 10,
          populatedDocRatio: 0.6,
        },
        acidity: {
          populatedDocCount: 6,
          totalDocCount: 10,
          populatedDocRatio: 0.6,
        },
        tannin: {
          populatedDocCount: 6,
          totalDocCount: 10,
          populatedDocRatio: 0.6,
        },
      },
    }, null, 2)}\n`,
  );
  await fs.writeFile(
    runtimeStatePath,
    `${JSON.stringify({
      schemaVersion: SEARCH_SNAPSHOT_STATE_VERSION,
      snapshotId: 'search-snapshot:v1:test',
      contentHash: 'content-hash',
      publishedAt: '2026-04-14T00:00:00.000Z',
      manifestPath,
      nlMappingsRuntimePath: nlMappingsPath,
      counts: {
        entities: args?.runtimeEntities ?? 10,
        aliases: 10,
        ambiguityRegistry: 0,
        nlMappings: 1,
        activeLtrModels: args?.activeLtrModels ?? 1,
      },
      hashes: {
        entities: entityHash,
        aliases: aliasHash,
        ambiguityRegistry: ambiguityHash,
        nlMappings: 'nl-hash',
        activeLtrModels: 'ltr-hash',
      },
      quality: {
        status: 'canonical',
        blockers: [],
        bypasses: [],
        carryForwardBenchmarkCount: 0,
        experimentalInputsPresent: false,
      },
      fieldAvailability: {
        appellation: {
          populatedDocCount: 8,
          totalDocCount: 10,
          populatedDocRatio: 0.8,
        },
        body: {
          populatedDocCount: 6,
          totalDocCount: 10,
          populatedDocRatio: 0.6,
        },
        sweetness: {
          populatedDocCount: 6,
          totalDocCount: 10,
          populatedDocRatio: 0.6,
        },
        acidity: {
          populatedDocCount: 6,
          totalDocCount: 10,
          populatedDocRatio: 0.6,
        },
        tannin: {
          populatedDocCount: 6,
          totalDocCount: 10,
          populatedDocRatio: 0.6,
        },
      },
    }, null, 2)}\n`,
  );

  return { runtimeStatePath, manifestPath };
}

describe('verifySearchSnapshotReadiness', () => {
  beforeEach(() => {
    mockVerifySearchSnapshotRuntimeStateLive.mockReset();
    mockVerifySearchSnapshotRuntimeStateLive.mockResolvedValue(undefined);
    mockCreatePgPool.mockClear();
  });

  it('passes when runtime state and manifest counts align', async () => {
    const { runtimeStatePath, manifestPath } = await writeFixtureFiles();

    await expect(
      verifySearchSnapshotReadiness({ runtimeStatePath, manifestPath, requirePointerParity: false }),
    ).resolves.toBeUndefined();

    expect(mockVerifySearchSnapshotRuntimeStateLive).toHaveBeenCalledTimes(1);
    expect(mockCreatePgPool).toHaveBeenCalledTimes(1);
    expect(mockVerifySearchSnapshotRuntimeStateLive.mock.calls[0]?.[0]?.requirePointerParity).toBeUndefined();
    expect(mockVerifySearchSnapshotRuntimeStateLive.mock.calls[0]?.[0]?.requireActiveLtr).toBe(false);
    expect(mockVerifySearchSnapshotRuntimeStateLive.mock.calls[0]?.[0]?.vespaMtls).toEqual({
      certPath: '/tmp/vespa-cert.pem',
      keyPath: '/tmp/vespa-key.pem',
    });
  });

  it('passes by default when runtime state has zero active LTR models', async () => {
    const { runtimeStatePath, manifestPath } = await writeFixtureFiles({ activeLtrModels: 0 });

    await expect(
      verifySearchSnapshotReadiness({
        runtimeStatePath,
        manifestPath,
        requirePointerParity: false,
        requireActiveLtr: false,
      }),
    ).resolves.toBeUndefined();

    expect(mockVerifySearchSnapshotRuntimeStateLive.mock.calls[0]?.[0]?.requireActiveLtr).toBe(false);
  });

  it('fails when active LTR is explicitly required and runtime state has zero active LTR models', async () => {
    const { runtimeStatePath, manifestPath } = await writeFixtureFiles({ activeLtrModels: 0 });

    await expect(
      verifySearchSnapshotReadiness({
        runtimeStatePath,
        manifestPath,
        requirePointerParity: false,
        requireActiveLtr: true,
      }),
    ).rejects.toThrow(/Active LTR model count is zero/);

    expect(mockVerifySearchSnapshotRuntimeStateLive.mock.calls[0]?.[0]?.requireActiveLtr).toBe(true);
  });

  it('fails closed when manifest entity count diverges from runtime state', async () => {
    const { runtimeStatePath, manifestPath } = await writeFixtureFiles({
      runtimeEntities: 10,
      manifestEntities: 9,
    });

    await expect(
      verifySearchSnapshotReadiness({ runtimeStatePath, manifestPath, requirePointerParity: true }),
    ).rejects.toThrow(/Entity state\/manifest mismatch/);
    expect(mockVerifySearchSnapshotRuntimeStateLive.mock.calls[0]?.[0]?.requirePointerParity).toBe(true);
  });
});
