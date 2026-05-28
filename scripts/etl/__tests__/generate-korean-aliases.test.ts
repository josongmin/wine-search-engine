import { describe, expect, it } from 'vitest';
import { createSourceRecordId } from '../../../src/domain/shared/types/index.js';
import type { EnrichedSilverRecord } from '../types.js';
import {
  detectCollisions,
  isKoreanHangulAliasCandidate,
  normalizeAliasKey,
  parseAliasMatrix,
} from '../generate-korean-aliases.js';

function makeRecord(sourceId: string, aliases: readonly string[]): EnrichedSilverRecord {
  return {
    sourceId: createSourceRecordId(sourceId),
    externalId: sourceId,
    canonicalLabel: `Wine ${sourceId}`,
    producer: 'Producer',
    vintageYear: null,
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
    pairingTags: [],
    flavorProfiles: [],
    searchTextEn: 'wine',
    ratingAvg: null,
    ratingsCount: 0,
    priceUsd: null,
    priceBand: 'mid',
    popularityScore: 0,
    scrapedAt: null,
    alcoholPct: null,
    producerPrestige: null,
    isTopRated: false,
    aliases: {
      proposed: [],
      identitySafeProjection: [],
      noisyRecallProjection: [...aliases],
    },
  };
}

describe('normalizeAliasKey', () => {
  it('trims and lowercases alias keys consistently', () => {
    expect(normalizeAliasKey('  샤토 마고  ')).toBe('샤토 마고');
  });
});

describe('parseAliasMatrix', () => {
  it('accepts a nested array contract with the expected batch size', () => {
    expect(parseAliasMatrix('[["a", "b"], ["c"]]', 2)).toEqual([['a', 'b'], ['c']]);
  });

  it('rejects a flat array contract', () => {
    expect(() => parseAliasMatrix('["a", "b"]', 2)).toThrow(/entry 0 was not an array/);
  });
});

describe('isKoreanHangulAliasCandidate', () => {
  it('accepts Hangul-bearing aliases', () => {
    expect(isKoreanHangulAliasCandidate('오푸스 원 2018')).toBe(true);
  });

  it('rejects Latin-only abbreviations', () => {
    expect(isKoreanHangulAliasCandidate('DRC')).toBe(false);
    expect(isKoreanHangulAliasCandidate('MRB')).toBe(false);
  });

  it('rejects mixed-script aliases', () => {
    expect(isKoreanHangulAliasCandidate('오푸스 원 DRC')).toBe(false);
  });
});

describe('detectCollisions', () => {
  it('treats whitespace and case variants as the same alias key', () => {
    const records = [
      makeRecord('s1', ['샤토 마고']),
      makeRecord('s2', [' other alias ']),
    ];
    const collisions = detectCollisions(records, new Map([
      ['s2', ['  샤토 마고  ']],
    ]));

    expect(collisions.get('s2')).toEqual(['  샤토 마고  ']);
  });
});
