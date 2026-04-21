import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EntitySnapshotRecord } from '../../../scripts/etl/search-snapshot-schema.js';
import { serializeNdjson } from '../../../scripts/etl/search-snapshot-schema.js';
import {
  assertLearnedFacetCoverageForPublish,
  assertEntityIdentitySignatureConsistency,
  assertSnapshotArtifactLearnedFacetCoverage,
  collectLearnedFacetCoverageFromEntities,
  resolveRuntimeSubstrateCutoverPaths,
} from '../../../scripts/etl/publish-runtime-substrates.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'publish-runtime-substrates-'));
}

function baseEntity(overrides: Partial<EntitySnapshotRecord> = {}): EntitySnapshotRecord {
  return {
    entityId: 'opus-one-2018',
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    identitySignature: 'a'.repeat(64),
    relations: {},
    attributes: { vintage: 2018, style: 'red' },
    metadata: {
      identityResolution: 'gold_overlay',
      benchmarkEntityId: 'opus-one-2018',
      producer: 'Opus One',
      country: 'United States',
      region: 'Napa Valley',
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'vivino-opus' }],
    },
    ...overrides,
  };
}

describe('publish-runtime-substrates identity signature guard', () => {
  it('allows an empty batch', async () => {
    const client = {
      query: async () => ({ rows: [] }),
    };

    await expect(
      assertEntityIdentitySignatureConsistency(client, []),
    ).resolves.toBeUndefined();
  });

  it('fails closed when an existing entity_id would be remapped to a new identity signature', async () => {
    const client = {
      query: async () => ({
        rows: [
          {
            entity_id: 'opus-one-2018',
            identity_signature: 'different-signature',
          },
        ],
      }),
    };

    await expect(
      assertEntityIdentitySignatureConsistency(client, [baseEntity()]),
    ).rejects.toThrow(/refusing to remap/);
  });

  it('fails closed when the same identity signature already belongs to a different entity_id', async () => {
    const client = {
      query: async () => ({
        rows: [
          {
            entity_id: 'other-entity',
            identity_signature: 'a'.repeat(64),
          },
        ],
      }),
    };

    await expect(
      assertEntityIdentitySignatureConsistency(client, [baseEntity()]),
    ).rejects.toThrow(/already belongs to entity_id/);
  });
});

describe('publish-runtime-substrates learned facet guard', () => {
  it('counts learned facet coverage from the entity artifact', () => {
    expect(
      collectLearnedFacetCoverageFromEntities([
        baseEntity({
          entityId: 'wine-red',
          identitySignature: 'a'.repeat(64),
          attributes: {
            wineType: 'red',
            giftSuitabilityScore: 0.82,
            beginnerSuitabilityScore: 0.76,
          },
        }),
        baseEntity({
          entityId: 'wine-white',
          canonicalLabel: 'Opus White',
          identitySignature: 'b'.repeat(64),
          attributes: {
            wineType: 'white',
            giftSuitabilityScore: 0.61,
            beginnerSuitabilityScore: 0.88,
          },
        }),
      ]),
    ).toEqual({
      giftSuitabilityScore: 2,
      beginnerSuitabilityScore: 2,
    });
  });

  it('fails closed when the entity artifact is missing gift or beginner suitability scores', async () => {
    const dir = await makeTempDir();
    const entitiesPath = path.join(dir, 'entities.ndjson');
    await fs.writeFile(
      entitiesPath,
      serializeNdjson([
        {
          entityId: 'wine-red',
          entityType: 'wine',
          canonicalLabel: 'Red Wine',
          identitySignature: 'a'.repeat(64),
          relations: {},
          attributes: {
            wineType: 'red',
            giftSuitabilityScore: 0.82,
          },
          metadata: {},
        },
      ]),
    );

    await expect(
      assertSnapshotArtifactLearnedFacetCoverage({
        snapshotId: 'search-snapshot:v1:test',
        artifacts: {
          entitiesNdjson: entitiesPath,
        },
      }),
    ).rejects.toThrow(/beginnerSuitabilityScore=0\/1/);
  });

  it('fails closed when coverage is incomplete even if some scores exist', () => {
    expect(() =>
      assertLearnedFacetCoverageForPublish(
        {
          giftSuitabilityScore: 1,
          beginnerSuitabilityScore: 0,
        },
        'entities artifact',
        'search-snapshot:v1:test',
        1,
      ),
    ).toThrow(/beginnerSuitabilityScore=0\/1/);
  });
});

describe('resolveRuntimeSubstrateCutoverPaths', () => {
  it('uses snapshot-bound nl mappings artifact paths for promotion source', () => {
    expect(
      resolveRuntimeSubstrateCutoverPaths({
        snapshotId: 'search-snapshot:v1:test',
        runtimeStatePath: '/tmp/runtime-search-snapshot.json',
        runtimeNlMappingsPath: '/tmp/nl-mappings.json',
      }),
    ).toEqual({
      stagedRuntimeStatePath: '/tmp/runtime-search-snapshot.search-snapshot:v1:test.staging.json',
      activeRuntimeStatePath: '/tmp/runtime-search-snapshot.json',
      stagedRuntimeNlMappingsPath: '/tmp/nl-mappings.search-snapshot:v1:test.json',
      activeRuntimeNlMappingsPath: '/tmp/nl-mappings.json',
    });
  });
});
