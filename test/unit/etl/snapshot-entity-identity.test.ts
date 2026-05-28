import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEntityIdBySourceId,
  goldMatchKey,
  loadGoldCanonicalLookup,
  loadSourceEntityContinuityFromManifestPath,
  resolveWineSnapshotEntity,
  SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX,
  type WineSnapshotIdentityRow,
} from '../../../scripts/etl/snapshot-entity-identity.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import { createCanonicalEntityId } from '../../../src/domain/shared/types/entity-id.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-entity-identity-'));
}

function opusRecord(): EnrichedSilverRecord {
  return {
    sourceId: 'vivino-test-opus',
    externalId: 'ext',
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    vintageYear: 2018,
    country: 'United States',
    region: 'Napa Valley',
    appellation: null,
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon'],
    body: 0.8,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.7,
    pairingTags: [],
    flavorProfiles: [],
    searchTextEn: 'test',
    ratingAvg: 4.5,
    ratingsCount: 10,
    priceUsd: 100,
    priceBand: 'luxury',
    popularityScore: 0.5,
    scrapedAt: null,
    alcoholPct: null,
    producerPrestige: null,
    isTopRated: false,
    aliases: { proposed: [], identitySafeProjection: [], noisyRecallProjection: [] },
  };
}

describe('snapshot-entity-identity', () => {
  it('goldMatchKey aligns label normalization with identity signature plane', () => {
    expect(goldMatchKey('  Opus  One   2018 ', 2018)).toBe('opus one 2018|2018');
    expect(goldMatchKey('Moët', null)).toBe('moët|nv');
  });

  it('rejects vivino- prefixed ids in canonical-entities.json', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, 'goldens'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'goldens', 'canonical-entities.json'),
      JSON.stringify({
        entities: [
          {
            entity_id: 'vivino-bad',
            canonical_label: 'X',
            vintage: 2020,
          },
        ],
      }),
    );
    await expect(loadGoldCanonicalLookup(dir)).rejects.toThrow(/source_record namespace/);
  });

  it('rejects duplicate gold keys for different entity ids', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, 'goldens'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'goldens', 'canonical-entities.json'),
      JSON.stringify({
        entities: [
          { entity_id: 'a-2018', canonical_label: 'Same Label', vintage: 2018 },
          { entity_id: 'b-2018', canonical_label: 'Same Label', vintage: 2018 },
        ],
      }),
    );
    await expect(loadGoldCanonicalLookup(dir)).rejects.toThrow(/duplicate gold key/);
  });

  it('resolveWineSnapshotEntity prefers gold overlay over fallback', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, 'goldens'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'goldens', 'canonical-entities.json'),
      JSON.stringify({
        entities: [
          { entity_id: 'opus-one-2018', canonical_label: 'Opus One 2018', vintage: 2018 },
        ],
      }),
    );
    const lookup = await loadGoldCanonicalLookup(dir);
    const resolved = resolveWineSnapshotEntity(opusRecord(), lookup);
    expect(resolved.entityId.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(resolved.runtimePublicIdAuthority).toBe('identity_signature');
    expect(resolved.resolution).toBe('gold_overlay');
    expect(resolved.benchmarkEntityId).toBe('opus-one-2018');
    expect(resolved.benchmarkLinkageAuthority).toBe('benchmark_linkage');
  });

  it('resolveWineSnapshotEntity uses deterministic wine-ce signature fallback', () => {
    const resolved = resolveWineSnapshotEntity(opusRecord(), new Map());
    expect(resolved.entityId.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(resolved.runtimePublicIdAuthority).toBe('identity_signature');
    expect(resolved.resolution).toBe('identity_signature');
    expect(resolved.entityId.includes('vivino')).toBe(false);
    expect(resolved.benchmarkEntityId).toBeUndefined();
    expect(resolved.benchmarkLinkageAuthority).toBeUndefined();
  });

  it('resolveWineSnapshotEntity accepts a minimal WineSnapshotIdentityRow (no full EnrichedSilverRecord)', () => {
    const row: WineSnapshotIdentityRow = {
      sourceId: 'src-1',
      canonicalLabel: 'Test Wine 2020',
      producer: 'Test Producer',
      country: 'France',
      region: 'Bordeaux',
      vintageYear: 2020,
    };
    const resolved = resolveWineSnapshotEntity(row, new Map());
    expect(resolved.entityId.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(resolved.runtimePublicIdAuthority).toBe('identity_signature');
    expect(resolved.resolution).toBe('identity_signature');
  });

  it('buildEntityIdBySourceId maps every silver sourceId to a canonical entity id', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, 'goldens'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'goldens', 'canonical-entities.json'),
      JSON.stringify({
        entities: [
          { entity_id: 'opus-one-2018', canonical_label: 'Opus One 2018', vintage: 2018 },
        ],
      }),
    );
    const lookup = await loadGoldCanonicalLookup(dir);
    const other: EnrichedSilverRecord = {
      ...opusRecord(),
      sourceId: 'vivino-other',
      canonicalLabel: 'Other Wine 2020',
      vintageYear: 2020,
    };
    const map = buildEntityIdBySourceId([opusRecord(), other], lookup);
    expect(map.get('vivino-test-opus')?.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    const otherId = map.get('vivino-other');
    expect(otherId).toBeDefined();
    expect(otherId!.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(otherId!.includes('vivino')).toBe(false);
  });

  it('buildEntityIdBySourceId preserves snapshot continuity ids when provided', () => {
    const continuityEntityId = createCanonicalEntityId('wine-ce-continuity-opus-2018');
    const continuity = new Map([
      ['vivino-test-opus', {
        entityId: continuityEntityId,
        identitySignature: 'continuity-signature',
      }],
    ]);
    const map = buildEntityIdBySourceId([opusRecord()], new Map(), continuity);
    expect(map.get('vivino-test-opus')).toBe(continuityEntityId);
  });

  it('loads source continuity from a snapshot manifest entities artifact', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'manifest.json');
    const entitiesPath = path.join(dir, 'entities.ndjson');
    await fs.writeFile(
      entitiesPath,
      `${JSON.stringify({
        entityId: 'wine-ce-runtime-opus-2018',
        entityType: 'wine',
        canonicalLabel: 'Opus One 2018',
        identitySignature: 'runtime-signature',
        relations: {},
        attributes: {},
        metadata: {
          benchmarkEntityId: 'gold-opus-one-2018',
          sourceRecordRefs: [{
            sourceSystem: 'vivino-silver',
            sourceRecordId: 'vivino-test-opus',
          }],
        },
      })}\n`,
    );
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        schemaVersion: 'search_snapshot.v1',
        snapshotId: 'search-snapshot:v1:test',
        generatedAt: '2026-05-28T00:00:00.000Z',
        contentHash: 'hash-test',
        sourceInputPath: '/tmp/input.ndjson',
        artifacts: {
          documentsNdjson: '/tmp/documents.ndjson',
          vespaFeedNdjson: '/tmp/vespa-feed.ndjson',
          entitiesNdjson: entitiesPath,
          aliasesNdjson: '/tmp/aliases.ndjson',
          ambiguityRegistryNdjson: '/tmp/ambiguity.ndjson',
          nlMappingsJson: '/tmp/nl-mappings.json',
          metadataJson: '/tmp/metadata.json',
        },
        counts: {
          documents: 1,
          vespaFeed: 1,
          entities: 1,
          aliases: 0,
          ambiguityRegistry: 0,
          nlMappings: 0,
        },
        hashes: {
          documents: 'hash-documents',
          vespaFeed: 'hash-vespa',
          entities: 'hash-entities',
          aliases: 'hash-aliases',
          ambiguityRegistry: 'hash-ambiguity',
          nlMappings: 'hash-nl',
        },
        fieldAvailability: {
          appellation: { populatedDocCount: 0, totalDocCount: 1, populatedDocRatio: 0 },
          body: { populatedDocCount: 0, totalDocCount: 1, populatedDocRatio: 0 },
          sweetness: { populatedDocCount: 0, totalDocCount: 1, populatedDocRatio: 0 },
          acidity: { populatedDocCount: 0, totalDocCount: 1, populatedDocRatio: 0 },
          tannin: { populatedDocCount: 0, totalDocCount: 1, populatedDocRatio: 0 },
        },
        quality: {
          status: 'canonical',
          blockers: [],
          bypasses: [],
          carryForwardBenchmarkCount: 0,
          experimentalInputsPresent: false,
        },
      }),
    );

    const continuity = await loadSourceEntityContinuityFromManifestPath(manifestPath);
    expect(continuity.get('vivino-test-opus')).toEqual({
      entityId: 'wine-ce-runtime-opus-2018',
      identitySignature: 'runtime-signature',
      benchmarkEntityId: 'gold-opus-one-2018',
    });
  });
});
