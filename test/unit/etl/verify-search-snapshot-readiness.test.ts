import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEARCH_SNAPSHOT_SCHEMA_VERSION,
  SEARCH_SNAPSHOT_STATE_VERSION,
} from '../../../src/domain/shared/constants/search-snapshot.js';

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
}): Promise<{
  readonly runtimeStatePath: string;
  readonly manifestPath: string;
}> {
  const dir = await makeTempDir();
  const manifestPath = path.join(dir, 'manifest.json');
  const runtimeStatePath = path.join(dir, 'runtime-state.json');
  const nlMappingsPath = path.join(dir, 'nl-mappings.json');

  await fs.writeFile(nlMappingsPath, JSON.stringify({ mappings: [{ key: 'full-bodied', canonical: 'full_bodied' }] }));
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: SEARCH_SNAPSHOT_SCHEMA_VERSION,
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-04-14T00:00:00.000Z',
      contentHash: 'content-hash',
      sourceInputPath: '/tmp/silver-trackc.ndjson',
      artifacts: {
        documentsNdjson: '/tmp/documents.ndjson',
        vespaFeedNdjson: '/tmp/vespa-feed.ndjson',
        entitiesNdjson: '/tmp/entities.ndjson',
        aliasesNdjson: '/tmp/aliases.ndjson',
        ambiguityRegistryNdjson: '/tmp/ambiguity.ndjson',
        nlMappingsJson: nlMappingsPath,
        metadataJson: '/tmp/metadata.json',
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
        entities: 'entities-hash',
        aliases: 'aliases-hash',
        ambiguityRegistry: 'ambiguity-hash',
        nlMappings: 'nl-hash',
      },
      quality: {
        status: 'canonical',
        blockers: [],
        bypasses: [],
        carryForwardBenchmarkCount: 0,
        experimentalInputsPresent: false,
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
        activeLtrModels: 1,
      },
      hashes: {
        entities: 'entities-hash',
        aliases: 'aliases-hash',
        ambiguityRegistry: 'ambiguity-hash',
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
    expect(mockVerifySearchSnapshotRuntimeStateLive.mock.calls[0]?.[0]?.vespaMtls).toEqual({
      certPath: '/tmp/vespa-cert.pem',
      keyPath: '/tmp/vespa-key.pem',
    });
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
