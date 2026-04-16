import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSearchSnapshot } from '../../../scripts/etl/build-search-snapshot.js';
import { parseNdjson } from '../../../scripts/etl/ndjson.js';
import type { EntitySnapshotRecord } from '../../../scripts/etl/search-snapshot-schema.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import { SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX } from '../../../scripts/etl/snapshot-entity-identity.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'build-search-snapshot-'));
}

function makeRecord(): EnrichedSilverRecord {
  return {
    sourceId: 'wine-opus-one',
    externalId: 'opus-one-ext',
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    vintageYear: 2018,
    country: 'United States',
    region: 'Napa Valley',
    appellation: 'Oakville',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.9,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.8,
    pairingTags: ['steak'],
    flavorProfiles: ['black-fruit', 'oak'],
    searchTextEn: 'Opus One 2018 Napa Valley Cabernet blend.',
    ratingAvg: 4.8,
    ratingsCount: 1200,
    priceUsd: 420,
    priceBand: 'luxury',
    popularityScore: 0.95,
    scrapedAt: '2026-04-12T00:00:00.000Z',
    alcoholPct: 14.5,
    producerPrestige: 0.98,
    isTopRated: true,
    aliases: {
      proposed: [],
      identitySafeProjection: [],
      noisyRecallProjection: [],
    },
  };
}

describe('buildSearchSnapshot', () => {
  it('emits entity artifact and manifest counts for runtime entity plane', async () => {
    const dir = await makeTempDir();
    const inputPath = path.join(dir, 'silver-trackc.ndjson');
    const outputDir = path.join(dir, 'search-snapshots');
    const nlMappingsPath = path.join(dir, 'nl-mappings.json');

    await fs.writeFile(inputPath, `${JSON.stringify(makeRecord())}\n`);
    await fs.writeFile(nlMappingsPath, JSON.stringify({
      mappings: [{ key: 'full-bodied', canonical: 'full_bodied' }],
    }));

    const fixtureRoot = path.join(dir, 'wine-engine-fixture');
    await fs.mkdir(path.join(fixtureRoot, 'goldens'), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, 'goldens', 'canonical-entities.json'),
      `${JSON.stringify({
        _type: 'goldens',
        entities: [
          {
            entity_id: 'opus-one-2018',
            canonical_label: 'Opus One 2018',
            vintage: 2018,
          },
        ],
      })}\n`,
    );

    const result = await buildSearchSnapshot({
      input: inputPath,
      outputDir,
      nlMappings: nlMappingsPath,
      fixtureRepoRoot: fixtureRoot,
    });

    expect(result.manifest.counts.documents).toBe(1);
    expect(result.manifest.counts.vespaFeed).toBe(0);
    expect(result.manifest.counts.entities).toBe(1);
    expect(result.manifest.hashes.entities).toMatch(/^[a-f0-9]{64}$/);
    expect(result.manifest.artifacts.vespaFeedNdjson).toMatch(/vespa-feed\.ndjson$/);
    await expect(fs.access(result.manifest.artifacts.vespaFeedNdjson)).rejects.toThrow();

    const entitiesRaw = await fs.readFile(result.manifest.artifacts.entitiesNdjson, 'utf8');
    const entityRows = parseNdjson<EntitySnapshotRecord>(
      entitiesRaw,
      result.manifest.artifacts.entitiesNdjson,
    ).records;

    expect(entityRows).toHaveLength(1);
    expect(entityRows[0]?.entityId.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(entityRows[0]).toMatchObject({
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
    });
    expect(entityRows[0]?.identitySignature).toMatch(/^[a-f0-9]{64}$/);
    expect(entityRows[0]?.metadata).toMatchObject({
      identityResolution: 'gold_overlay',
      benchmarkEntityId: 'opus-one-2018',
      region: 'Napa Valley',
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'wine-opus-one' }],
    });
    expect(entityRows[0]?.attributes).toMatchObject({
      wineType: 'red',
      style: 'red',
      vintage: 2018,
      region: 'Napa Valley',
      priceBand: 'luxury',
    });
  });
});
