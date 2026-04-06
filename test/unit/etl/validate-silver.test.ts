import { describe, expect, it } from 'vitest';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import {
  SILVER_QUALITY_GATES,
  validateSilverRecords,
  type SilverQualityGateThresholds,
} from '../../../scripts/etl/validate-silver.js';

function makeEnrichedRecord(
  overrides: Partial<EnrichedSilverRecord> = {},
): EnrichedSilverRecord {
  return {
    sourceId: 'vivino:test-record',
    externalId: 'fixture-1',
    canonicalLabel: 'Fixture Wine',
    producer: 'Fixture Producer',
    vintageYear: 2020,
    country: 'France',
    region: 'Bordeaux',
    appellation: 'Medoc',
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon'],
    body: 0.6,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.4,
    pairingTags: ['lamb'],
    flavorProfiles: ['black fruit'],
    searchTextEn: 'Layered cassis, graphite, and cedar with a long finish.',
    ratingAvg: 4.4,
    ratingsCount: 120,
    priceUsd: 55,
    priceBand: 'premium',
    popularityScore: 0.65,
    scrapedAt: '2026-04-06T00:00:00.000Z',
    aliases: {
      proposed: [
        {
          value: 'Fixture Wine',
          type: 'catalog_noise_alias',
          source: 'fixture',
          confidencePrior: 0.8,
          needsReview: false,
        },
        {
          value: '픽스처 와인',
          type: 'translation',
          source: 'fixture',
          confidencePrior: 0.9,
          needsReview: false,
        },
        {
          value: 'Fixture Producer Medoc',
          type: 'catalog_noise_alias',
          source: 'fixture',
          confidencePrior: 0.7,
          needsReview: false,
        },
      ],
      identitySafeProjection: ['Fixture Wine'],
      noisyRecallProjection: ['Fixture Wine', '픽스처 와인', 'Fixture Producer Medoc'],
    },
    ...overrides,
  };
}

const SMALL_GATES: SilverQualityGateThresholds = {
  ...SILVER_QUALITY_GATES,
  minRecords: 2,
  minTastingNotesCoverage: 0.5,
  minAliasMeanCount: 2,
};

describe('validateSilverRecords', () => {
  it('passes a healthy small fixture when thresholds are scaled down for tests', () => {
    const report = validateSilverRecords(
      [
        makeEnrichedRecord({ sourceId: 'vivino:test-record-1', externalId: 'fixture-1' }),
        makeEnrichedRecord({ sourceId: 'vivino:test-record-2', externalId: 'fixture-2' }),
      ],
      SMALL_GATES,
    );

    expect(report.passed).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.fieldCoverage.searchTextEn).toBe(1);
    expect(report.distributionChecks.aliasMeanCount).toBeGreaterThanOrEqual(3);
  });

  it('reports blockers for undersized, under-aliased fixtures', () => {
    const report = validateSilverRecords(
      [
        makeEnrichedRecord({
          searchTextEn: 'too short',
          aliases: {
            proposed: [
              {
                value: 'Fixture Wine',
                type: 'catalog_noise_alias',
                source: 'fixture',
                confidencePrior: 0.8,
                needsReview: false,
              },
            ],
            identitySafeProjection: ['Fixture Wine'],
            noisyRecallProjection: ['Fixture Wine'],
          },
        }),
      ],
      SMALL_GATES,
    );

    expect(report.passed).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Record count 1 < minimum 2'),
        expect.stringContaining('Tasting notes coverage'),
        expect.stringContaining('Mean alias count 1.0 < minimum 2'),
      ]),
    );
  });

  it('returns stable zero coverage metrics for empty inputs', () => {
    const report = validateSilverRecords([], SMALL_GATES);

    expect(report.passed).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Record count 0 < minimum 2'),
        expect.stringContaining('Tasting notes coverage 0.0% < minimum 50%'),
        expect.stringContaining('Mean alias count 0.0 < minimum 2'),
      ]),
    );
    expect(report.fieldCoverage).toEqual({
      producer: 0,
      country: 0,
      region: 0,
      grapePrimary: 0,
      priceUsd: 0,
      searchTextEn: 0,
      flavorProfiles: 0,
      pairingTags: 0,
      vintageYear: 0,
      alcoholPct: 0,
      producerPrestige: 0,
      criticProxy: 0,
      drinkingWindow: 0,
    });
  });
});
