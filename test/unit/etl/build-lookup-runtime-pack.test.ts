import { describe, expect, it } from 'vitest';
import {
  buildLookupAliasRuntimeArtifacts,
  buildLookupEntityProjectionArtifact,
} from '../../../scripts/etl/build-lookup-runtime-pack.js';
import type { AliasSnapshotRecord } from '../../../scripts/etl/search-snapshot-schema.js';
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
  it('publishes Hangul completion and DM sidecars in the split broad-recall artifact', () => {
    const aliases: readonly AliasSnapshotRecord[] = [
      {
        aliasId: 'alias-opus-one-ko',
        entityId: 'wine-opus-one',
        value: '오푸스 원',
        normalizedValue: '오푸스 원',
        type: 'canonical',
        aliasType: 'canonical',
        scope: 'entity',
        source: 'fixture',
        sourceTrust: 1,
        confidencePrior: 0.99,
      },
      {
        aliasId: 'alias-opus-one-en',
        entityId: 'wine-opus-one',
        value: 'Opus One',
        normalizedValue: 'opus one',
        type: 'canonical',
        aliasType: 'canonical',
        scope: 'entity',
        source: 'fixture',
        sourceTrust: 1,
        confidencePrior: 0.99,
      },
    ];

    const { broadRecallArtifact } = buildLookupAliasRuntimeArtifacts({
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-08T00:00:00.000Z',
      aliasRegistryHash: 'alias-hash',
      aliases,
    });

    expect(broadRecallArtifact.doubleMetaphoneKeysByAliasId).toBeDefined();
    expect(broadRecallArtifact.doubleMetaphoneKeysByAliasId?.['alias-opus-one-en']).toBeDefined();
    expect(broadRecallArtifact.hangulCompletionRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          aliasIndex: 0,
          jamoKey: expect.any(String),
        }),
      ]),
    );
  });

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

  it('unions reviewed family-core witness surfaces into familyCoreKeys for snapshot-published descriptor canonicalization', () => {
    const solaia = makeRecord({
      sourceId: 'wine-solaia',
      canonicalLabel: "2018 Antinori Tenuta Tignanello 'Solaia'",
      producer: 'Antinori',
      aliases: {
        proposed: [],
        identitySafeProjection: ["2018 Antinori Tenuta Tignanello 'Solaia'"],
        noisyRecallProjection: [],
      },
      searchTextEn: "Antinori Tenuta Tignanello Solaia 2018",
    });

    const artifact = buildLookupEntityProjectionArtifact({
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-06T00:00:00.000Z',
      records: [solaia],
      entityIdBySourceId: new Map([
        ['wine-solaia', 'wine-ce-solaia'],
      ]),
      goldCanonicalLookup: new Map(),
      sourceContinuityLookup: new Map(),
      reviewedFamilyCoreKeysByEntity: new Map([
        ['wine-ce-solaia', ['solaia']],
      ]),
    });

    const solaiaDoc = artifact.documents.find((doc) => doc.entityId === 'wine-ce-solaia');
    expect(solaiaDoc?.familyCoreKeys).toEqual(
      expect.arrayContaining(['solaia']),
    );
  });

  it('does not promote grape-only remainders into familyCoreKeys for benchmark-anchor style flagship labels', () => {
    const screamingEagle = makeRecord({
      sourceId: 'benchmark-anchor-w-screaming-eagle-2018',
      externalId: 'w-screaming-eagle-2018',
      canonicalLabel: 'Screaming Eagle Cabernet Sauvignon 2018',
      producer: 'Screaming Eagle',
      vintageYear: 2018,
      region: 'Napa Valley',
      appellation: 'Oakville',
      grapes: ['Cabernet Sauvignon'],
      aliases: {
        proposed: [],
        identitySafeProjection: [
          'Screaming Eagle Cabernet Sauvignon 2018',
          '스크리밍 이글',
          '스크리밍이글',
        ],
        noisyRecallProjection: ['스크리밍 이글', '스크리밍이글'],
      },
      searchTextEn: 'Screaming Eagle Cabernet Sauvignon 2018 Napa Valley Oakville',
    });

    const artifact = buildLookupEntityProjectionArtifact({
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-06T00:00:00.000Z',
      records: [screamingEagle],
      entityIdBySourceId: new Map([
        ['benchmark-anchor-w-screaming-eagle-2018', 'w-screaming-eagle-2018'],
      ]),
      goldCanonicalLookup: new Map(),
      sourceContinuityLookup: new Map(),
    });

    const screamingEagleDoc = artifact.documents.find((doc) => doc.entityId === 'w-screaming-eagle-2018');
    expect(screamingEagleDoc?.familyCoreKeys).toEqual(
      expect.arrayContaining(['스크리밍 이글']),
    );
    expect(screamingEagleDoc?.familyCoreKeys).not.toEqual(
      expect.arrayContaining(['cabernet', 'cabernet sauvignon']),
    );
  });
});
