import { describe, expect, it } from 'vitest';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import {
  buildSearchTextKo,
  deterministicEmbedding,
  silverToRetrievalDoc,
} from '../../../scripts/etl/index-to-vespa.js';
import { toVespaFields } from '../../../src/infrastructure/vespa/mapping.js';

function makeEnrichedRecord(
  overrides: Partial<EnrichedSilverRecord> = {},
): EnrichedSilverRecord {
  return {
    sourceId: 'vivino:opus-one-2018',
    externalId: '123',
    canonicalLabel: 'Opus One 2018',
    producer: 'Opus One',
    vintageYear: 2018,
    country: 'United States',
    region: 'Napa Valley',
    appellation: 'Oakville',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.82,
    sweetness: 0.08,
    acidity: 0.56,
    tannin: 0.71,
    pairingTags: ['steak', 'aged cheese'],
    flavorProfiles: ['black fruit', 'cedar'],
    searchTextEn: 'Full-bodied Napa Cabernet with dark fruit and cedar.',
    ratingAvg: 4.7,
    ratingsCount: 812,
    priceUsd: 420,
    priceBand: 'luxury',
    popularityScore: 0.93,
    scrapedAt: '2026-04-06T00:00:00.000Z',
    aliases: {
      proposed: [
        {
          value: '오푸스원',
          type: 'translation',
          source: 'fixture',
          confidencePrior: 0.95,
          needsReview: false,
        },
        {
          value: 'Opus One',
          type: 'catalog_noise_alias',
          source: 'fixture',
          confidencePrior: 0.8,
          needsReview: false,
        },
      ],
      identitySafeProjection: ['Opus One 2018', 'Opus One'],
      noisyRecallProjection: ['Opus One', '오푸스원'],
    },
    ...overrides,
  };
}

describe('index-to-vespa bridge', () => {
  it('builds Korean search text from Hangul aliases only', () => {
    const record = makeEnrichedRecord();

    expect(buildSearchTextKo(record)).toBe('Opus One 2018 오푸스원');
  });

  it('maps enriched records into retrieval documents and omits absent optionals', () => {
    const record = makeEnrichedRecord({
      acidity: 0,
      tannin: 0,
      grapePrimary: null,
      country: '',
      priceUsd: null,
      flavorProfiles: [],
      ratingAvg: null,
    });

    const embedding = deterministicEmbedding(
      record.body,
      record.sweetness,
      record.acidity,
      record.tannin,
    );
    const doc = silverToRetrievalDoc(record, embedding);
    const fields = toVespaFields(doc);

    expect(doc.aliasesIdentitySafe).toEqual(['Opus One 2018', 'Opus One']);
    expect(doc.aliasesNoisyRecall).toEqual(['Opus One', '오푸스원']);
    expect(doc.searchTextKo).toBe('Opus One 2018 오푸스원');
    expect(doc.semanticSummary).toContain('Full-bodied Napa Cabernet');
    expect(doc.criticScoreNormalized).toBeUndefined();
    expect(doc.grapePrimary).toBeUndefined();
    expect(doc.country).toBeUndefined();
    expect(doc.priceUsd).toBeUndefined();
    expect(doc.flavorProfiles).toBeUndefined();

    expect(fields).not.toHaveProperty('grape_primary');
    expect(fields).not.toHaveProperty('country');
    expect(fields).not.toHaveProperty('price_usd');
    expect(fields).not.toHaveProperty('flavor_profiles');
    expect(fields).not.toHaveProperty('critic_score_normalized');
  });
});
