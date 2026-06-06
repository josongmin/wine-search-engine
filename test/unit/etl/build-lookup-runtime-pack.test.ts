import { describe, expect, it } from 'vitest';
import { buildLookupEntityProjectionArtifact } from '../../../scripts/etl/build-lookup-runtime-pack.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';

function makeRecord(overrides: Partial<EnrichedSilverRecord>): EnrichedSilverRecord {
  return {
    sourceId: 'wine-test-source',
    externalId: 'wine-test-ext',
    canonicalLabel: 'Base Wine 2018',
    producer: 'Base Producer',
    vintageYear: 2018,
    country: 'France',
    region: 'Bordeaux',
    appellation: 'Bordeaux',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon'],
    body: 0.8,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.7,
    pairingTags: ['beef'],
    flavorProfiles: ['blackcurrant'],
    searchTextEn: 'Base wine 2018 Bordeaux Cabernet Sauvignon',
    ratingAvg: 4.5,
    ratingsCount: 100,
    priceUsd: 100,
    priceBand: 'premium',
    popularityScore: 0.8,
    scrapedAt: '2026-06-06T00:00:00.000Z',
    alcoholPct: 14,
    aliases: {
      proposed: [],
      identitySafeProjection: [],
      noisyRecallProjection: [],
    },
    giftSuitabilityClassification: {
      score: 0.6,
      fingerprint: {
        modelId: 'gpt-test',
        contentHash: 'gift-hash',
        version: 'gift-v1',
        generatedAt: '2026-06-06T00:00:00.000Z',
      },
      provenance: {
        source: 'test',
        promptVersion: 'test',
        snippet: 'gift',
        rationale: 'gift',
      },
    },
    beginnerSuitabilityClassification: {
      score: 0.5,
      fingerprint: {
        modelId: 'gpt-test',
        contentHash: 'beginner-hash',
        version: 'beginner-v1',
        generatedAt: '2026-06-06T00:00:00.000Z',
      },
      provenance: {
        source: 'test',
        promptVersion: 'test',
        snippet: 'beginner',
        rationale: 'beginner',
      },
    },
    ...overrides,
  };
}

describe('buildLookupEntityProjectionArtifact', () => {
  it('emits familyCoreKeys from anchored noisy-recall aliases and producer-relative canonical cores only', () => {
    const calonSegur = makeRecord({
      sourceId: 'wine-calon-segur',
      canonicalLabel: '2003 Château Calon-Ségur Saint-Estèphe (Grand Cru Classé)',
      producer: 'Château Calon-Ségur',
      aliases: {
        proposed: [],
        identitySafeProjection: [
          '2003 Chateau Calon-Segur Saint-Estephe (Grand Cru Classe)',
          'Chateau Calon-Segur',
        ],
        noisyRecallProjection: [
          'Calon-Ségur',
          'France / France Cabernet Sauvignon',
        ],
      },
      searchTextEn: 'Calon Segur Saint-Estephe Bordeaux Cabernet Sauvignon',
    });
    const hillOfGrace = makeRecord({
      sourceId: 'wine-hill-of-grace',
      canonicalLabel: 'Henschke Hill of Grace 2018',
      producer: 'Henschke',
      aliases: {
        proposed: [],
        identitySafeProjection: ['Henschke Hill of Grace 2018'],
        noisyRecallProjection: [],
      },
      searchTextEn: 'Henschke Hill of Grace 2018',
    });

    const artifact = buildLookupEntityProjectionArtifact({
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-06T00:00:00.000Z',
      records: [calonSegur, hillOfGrace],
      entityIdBySourceId: new Map([
        ['wine-calon-segur', 'wine-ce-calon-segur'],
        ['wine-hill-of-grace', 'wine-ce-hill-of-grace'],
      ]),
      goldCanonicalLookup: new Map(),
      sourceContinuityLookup: new Map(),
    });

    const calonSegurDoc = artifact.documents.find((doc) => doc.entityId === 'wine-ce-calon-segur');
    expect(calonSegurDoc?.familyCoreKeys).toEqual(
      expect.arrayContaining(['calon-ségur', 'calon segur']),
    );
    expect(calonSegurDoc?.familyCoreKeys).not.toEqual(
      expect.arrayContaining(['france / france cabernet sauvignon', 'france france cabernet sauvignon']),
    );

    const hillOfGraceDoc = artifact.documents.find((doc) => doc.entityId === 'wine-ce-hill-of-grace');
    expect(hillOfGraceDoc?.familyCoreKeys).toEqual(
      expect.arrayContaining(['hill of grace']),
    );
  });
});
