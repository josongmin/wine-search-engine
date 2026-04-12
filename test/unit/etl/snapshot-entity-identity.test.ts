import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildEntityIdBySourceId,
  goldMatchKey,
  loadGoldCanonicalLookup,
  resolveWineSnapshotEntity,
  SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX,
  type WineSnapshotIdentityRow,
} from '../../../scripts/etl/snapshot-entity-identity.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';

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
    expect(resolved.entityId).toBe('opus-one-2018');
    expect(resolved.resolution).toBe('gold_overlay');
  });

  it('resolveWineSnapshotEntity uses deterministic wine-ce signature fallback', () => {
    const resolved = resolveWineSnapshotEntity(opusRecord(), new Map());
    expect(resolved.entityId.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(resolved.resolution).toBe('identity_signature');
    expect(resolved.entityId.includes('vivino')).toBe(false);
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
    expect(map.get('vivino-test-opus')).toBe('opus-one-2018');
    const otherId = map.get('vivino-other');
    expect(otherId).toBeDefined();
    expect(otherId!.startsWith(SNAPSHOT_CANONICAL_ENTITY_FALLBACK_PREFIX)).toBe(true);
    expect(otherId!.includes('vivino')).toBe(false);
  });
});
