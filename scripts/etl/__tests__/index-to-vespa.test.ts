import { describe, expect, it } from 'vitest';
import { createSourceRecordId } from '../../../src/domain/shared/types/index.js';
import type { EnrichedSilverRecord } from '../types.js';
import { silverToIndexable, buildSearchTextKo } from '../index-to-vespa.js';

function makeRecord(overrides: Partial<EnrichedSilverRecord> = {}): EnrichedSilverRecord {
  return {
    sourceId: createSourceRecordId('source-1'),
    externalId: 'external-1',
    canonicalLabel: 'Chateau Example 2019',
    producer: 'Chateau Example',
    vintageYear: 2019,
    country: 'France',
    region: 'Bordeaux',
    appellation: null,
    wineType: 'red',
    grapePrimary: null,
    grapes: ['Cabernet Sauvignon'],
    body: null,
    sweetness: null,
    acidity: null,
    tannin: null,
    pairingTags: ['cheese'],
    flavorProfiles: ['blackcurrant'],
    searchTextEn: 'Chateau Example Bordeaux Cabernet Sauvignon',
    ratingAvg: 4.3,
    ratingsCount: 100,
    priceUsd: null,
    priceBand: 'mid',
    popularityScore: 0.7,
    scrapedAt: '2026-01-01T00:00:00Z',
    alcoholPct: null,
    producerPrestige: null,
    isTopRated: false,
    aliases: {
      proposed: [],
      identitySafeProjection: ['Chateau Example 2019'],
      noisyRecallProjection: ['샤토 예제 2019'],
    },
    ...overrides,
  };
}

describe('buildSearchTextKo', () => {
  it('uses alias-derived Hangul text and ignores any prebuilt searchTextKo field', () => {
    const rec = makeRecord({
      aliases: {
        proposed: [],
        identitySafeProjection: ['Chateau Example 2019'],
        noisyRecallProjection: ['샤토 예제 2019'],
      },
    }) as EnrichedSilverRecord & { readonly searchTextKo?: string };
    Object.assign(rec, { searchTextKo: 'PREBUILT SHOULD NOT WIN' });

    expect(buildSearchTextKo(rec)).toBe('Chateau Example 2019 샤토 예제 2019');
  });
});

describe('silverToIndexable', () => {
  it('omits synthetic grapeFamily, regionHierarchy, style, and occasion when no authoritative source is present', () => {
    const indexable = silverToIndexable(makeRecord({
      grapePrimary: 'Mystery Grape',
      regionHierarchy: undefined,
      grapeFamily: undefined,
      occasion: undefined,
      body: null,
      sweetness: null,
    }));

    expect(indexable.grapeFamily).toBeUndefined();
    expect(indexable.regionHierarchy).toBeUndefined();
    expect(indexable.style).toBeUndefined();
    expect(indexable.occasion).toBeUndefined();
  });

  it('preserves explicit authoritative grapeFamily and regionHierarchy when provided upstream', () => {
    const indexable = silverToIndexable(makeRecord({
      grapeFamily: 'Cabernet',
      regionHierarchy: ['France', 'Bordeaux', 'Pauillac'],
    }));

    expect(indexable.grapeFamily).toBe('Cabernet');
    expect(indexable.regionHierarchy).toEqual(['France', 'Bordeaux', 'Pauillac']);
  });
});
