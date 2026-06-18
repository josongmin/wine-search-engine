import { describe, expect, it } from 'vitest';
import { buildLookupExactSafeEntityVintagesByIdFromSnapshotArtifacts } from '../../../scripts/etl/prune-lookup-exact-safe-registry.js';
import type { EntitySnapshotRecord } from '../../../scripts/etl/search-snapshot-schema.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';

function makeDocument(sourceId: string, vintageYear: number | null): EnrichedSilverRecord {
  return {
    sourceId,
    externalId: `${sourceId}-external`,
    canonicalLabel: `Wine ${sourceId}`,
    producer: 'Producer',
    vintageYear,
    country: 'France',
    region: 'Bordeaux',
    appellation: 'Pauillac',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon'],
    body: 0.8,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.8,
    pairingTags: ['steak'],
    flavorProfiles: ['black-fruit'],
    searchTextEn: 'fixture',
    ratingAvg: 4.7,
    ratingsCount: 100,
    priceUsd: 100,
    priceBand: 'premium',
    popularityScore: 0.9,
    scrapedAt: '2026-06-08T00:00:00.000Z',
    alcoholPct: 14,
    producerPrestige: 0.9,
    isTopRated: true,
    aliases: {
      proposed: [],
      identitySafeProjection: [],
      noisyRecallProjection: [],
    },
  };
}

function makeEntity(entityId: string, sourceRecordIds: readonly string[]): EntitySnapshotRecord {
  return {
    entityId,
    entityType: 'wine',
    canonicalLabel: entityId,
    identitySignature: entityId,
    relations: {},
    attributes: {},
    metadata: {
      sourceRecordRefs: sourceRecordIds.map((sourceRecordId) => ({
        sourceSystem: 'vivino-silver',
        sourceRecordId,
      })),
    },
  };
}

describe('prune-lookup-exact-safe-registry', () => {
  it('reconstructs entity vintages from snapshot documents and source-record lineage', () => {
    const vintages = buildLookupExactSafeEntityVintagesByIdFromSnapshotArtifacts({
      documents: [
        makeDocument('silver-1', 1996),
        makeDocument('silver-2', 2009),
        makeDocument('silver-3', null),
      ],
      entities: [
        makeEntity('latour-family', ['silver-1', 'silver-2', 'silver-3']),
        makeEntity('missing-doc', ['silver-404']),
      ],
    });

    expect(vintages).toEqual(new Map([
      ['latour-family', [1996, 2009]],
    ]));
  });
});
