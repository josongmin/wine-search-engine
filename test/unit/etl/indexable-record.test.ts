import { describe, expect, it } from 'vitest';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';
import {
  silverToIndexable,
  validateIndexableRecord,
} from '../../../scripts/etl/index-to-vespa.js';
import { silverGoldMatchKey } from '../../../scripts/etl/snapshot-entity-identity.js';

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
    scrapedAt: '2026-04-07T00:00:00.000Z',
    alcoholPct: 14.5,
    producerPrestige: 0.9,
    isTopRated: true,
    aliases: {
      proposed: [
        {
          value: '오푸스원',
          type: 'translation',
          source: 'fixture',
          confidencePrior: 0.95,
          needsReview: false,
        },
      ],
      identitySafeProjection: ['Opus One 2018', 'Opus One'],
      noisyRecallProjection: ['Opus One', '오푸스원'],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// silverToIndexable — hit projection field mapping
// ---------------------------------------------------------------------------

describe('silverToIndexable — hit projection fields', () => {
  it('uses identity-signature fallback entity id when no gold overlay matches', () => {
    const rec = makeEnrichedRecord();
    const indexable = silverToIndexable(rec, new Map());
    expect(typeof indexable.entityId).toBe('string');
    expect(indexable.entityId.startsWith('wine-ce-')).toBe(true);
    expect(indexable.entityId.length).toBeGreaterThan('wine-ce-'.length + 8);
  });

  it('uses identity-hash entity id even when gold overlay matches (gold slug goes to benchmarkEntityId)', () => {
    const rec = makeEnrichedRecord();
    const gold = new Map<string, string>([[silverGoldMatchKey(rec), 'opus-one-2018']]);
    const indexable = silverToIndexable(rec, gold);
    // resolveWineSnapshotEntity always returns the hash-based publicEntityId;
    // the gold slug is stored in benchmarkEntityId on the resolution object,
    // not propagated into silverToIndexable's entityId.
    expect(indexable.entityId.startsWith('wine-ce-')).toBe(true);
  });

  it('maps canonicalLabel', () => {
    const rec = makeEnrichedRecord();
    const indexable = silverToIndexable(rec);
    expect(indexable.canonicalLabel).toBe('Opus One 2018');
  });

  it('maps producer', () => {
    const rec = makeEnrichedRecord();
    const indexable = silverToIndexable(rec);
    expect(indexable.producer).toBe('Opus One');
  });

  it('maps region', () => {
    const rec = makeEnrichedRecord();
    const indexable = silverToIndexable(rec);
    expect(indexable.region).toBe('Napa Valley');
  });

  it('maps appellation when present', () => {
    const rec = makeEnrichedRecord({ appellation: 'Oakville' });
    const indexable = silverToIndexable(rec);
    expect(indexable.appellation).toBe('Oakville');
  });

  it('omits appellation when null', () => {
    const rec = makeEnrichedRecord({ appellation: null });
    const indexable = silverToIndexable(rec);
    expect(indexable).not.toHaveProperty('appellation');
  });

  it('maps grapePrimary when present', () => {
    const rec = makeEnrichedRecord({ grapePrimary: 'Cabernet Sauvignon' });
    const indexable = silverToIndexable(rec);
    expect(indexable.grapePrimary).toBe('Cabernet Sauvignon');
  });

  it('omits grapePrimary when null', () => {
    const rec = makeEnrichedRecord({ grapePrimary: null });
    const indexable = silverToIndexable(rec);
    expect(indexable).not.toHaveProperty('grapePrimary');
  });

  it('maps vintageYear when non-null', () => {
    const rec = makeEnrichedRecord({ vintageYear: 2018 });
    const indexable = silverToIndexable(rec);
    expect(indexable.vintageYear).toBe(2018);
  });

  it('omits vintageYear when null', () => {
    const rec = makeEnrichedRecord({ vintageYear: null });
    const indexable = silverToIndexable(rec);
    expect(indexable).not.toHaveProperty('vintageYear');
  });

  it('maps searchTextEn', () => {
    const rec = makeEnrichedRecord();
    const indexable = silverToIndexable(rec);
    expect(indexable.searchTextEn).toContain('Napa Cabernet');
  });

  it('maps producerPrestige when non-null', () => {
    const rec = makeEnrichedRecord({ producerPrestige: 0.9 });
    const indexable = silverToIndexable(rec);
    expect(indexable.producerPrestige).toBe(0.9);
  });

  it('omits producerPrestige when null', () => {
    const rec = makeEnrichedRecord({ producerPrestige: null });
    const indexable = silverToIndexable(rec);
    expect(indexable).not.toHaveProperty('producerPrestige');
  });

  it('maps avgCriticProxyScore from ratingAvg / 5', () => {
    const rec = makeEnrichedRecord({ ratingAvg: 4.5 });
    const indexable = silverToIndexable(rec);
    expect(indexable.avgCriticProxyScore).toBeCloseTo(0.9, 5);
  });

  it('omits avgCriticProxyScore when ratingAvg is null', () => {
    const rec = makeEnrichedRecord({ ratingAvg: null });
    const indexable = silverToIndexable(rec);
    expect(indexable).not.toHaveProperty('avgCriticProxyScore');
  });
});

// ---------------------------------------------------------------------------
// silverToIndexable — feature projection field mapping
// ---------------------------------------------------------------------------

describe('silverToIndexable — feature projection fields', () => {
  it('maps body', () => {
    const rec = makeEnrichedRecord({ body: 0.82 });
    const indexable = silverToIndexable(rec);
    expect(indexable.body).toBe(0.82);
  });

  it('maps sweetness', () => {
    const rec = makeEnrichedRecord({ sweetness: 0.08 });
    const indexable = silverToIndexable(rec);
    expect(indexable.sweetness).toBe(0.08);
  });

  it('maps tannin when > 0', () => {
    const rec = makeEnrichedRecord({ tannin: 0.71 });
    const indexable = silverToIndexable(rec);
    expect(indexable.tannin).toBe(0.71);
  });

  it('preserves tannin when 0 (legitimate zero — e.g. white wine)', () => {
    const rec = makeEnrichedRecord({ tannin: 0 });
    const indexable = silverToIndexable(rec);
    expect(indexable.tannin).toBe(0);
  });

  it('maps acidity when > 0', () => {
    const rec = makeEnrichedRecord({ acidity: 0.56 });
    const indexable = silverToIndexable(rec);
    expect(indexable.acidity).toBe(0.56);
  });

  it('preserves acidity when 0 (legitimate zero)', () => {
    const rec = makeEnrichedRecord({ acidity: 0 });
    const indexable = silverToIndexable(rec);
    expect(indexable.acidity).toBe(0);
  });

  it('maps criticScoreNormalized from ratingAvg', () => {
    const rec = makeEnrichedRecord({ ratingAvg: 4.0 });
    const indexable = silverToIndexable(rec);
    expect(indexable.criticScoreNormalized).toBeCloseTo(0.8, 5);
  });

  it('omits criticScoreNormalized when ratingAvg is null', () => {
    const rec = makeEnrichedRecord({ ratingAvg: null });
    const indexable = silverToIndexable(rec);
    expect(indexable).not.toHaveProperty('criticScoreNormalized');
  });
});

// ---------------------------------------------------------------------------
// validateIndexableRecord — required field checks
// ---------------------------------------------------------------------------

describe('validateIndexableRecord — required fields', () => {
  it('passes for a fully valid indexable record', () => {
    const rec = makeEnrichedRecord();
    const indexable = silverToIndexable(rec);
    const result = validateIndexableRecord(indexable);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('catches missing entityId (empty string)', () => {
    const rec = makeEnrichedRecord();
    const indexable = { ...silverToIndexable(rec), entityId: '' };
    const result = validateIndexableRecord(indexable);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('entityId'))).toBe(true);
  });

  it('catches missing canonicalLabel (empty string)', () => {
    const rec = makeEnrichedRecord();
    const indexable = { ...silverToIndexable(rec), canonicalLabel: '' };
    const result = validateIndexableRecord(indexable);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('canonicalLabel'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateIndexableRecord — feature range checks
// ---------------------------------------------------------------------------

describe('validateIndexableRecord — body out of range', () => {
  it('catches body below 0', () => {
    const rec = makeEnrichedRecord();
    const indexable = { ...silverToIndexable(rec), body: -0.1 };
    const result = validateIndexableRecord(indexable);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('body'))).toBe(true);
  });

  it('catches body above 1 (e.g. 6 — raw Vivino scale leaked in)', () => {
    const rec = makeEnrichedRecord();
    const indexable = { ...silverToIndexable(rec), body: 6 };
    const result = validateIndexableRecord(indexable);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('body'))).toBe(true);
  });

  it('accepts body exactly at 0', () => {
    const rec = makeEnrichedRecord();
    const indexable = { ...silverToIndexable(rec), body: 0 };
    const result = validateIndexableRecord(indexable);
    // body=0 is technically valid (edge of range)
    expect(result.errors.some((e) => e.includes('body'))).toBe(false);
  });

  it('accepts body exactly at 1', () => {
    const rec = makeEnrichedRecord();
    const indexable = { ...silverToIndexable(rec), body: 1 };
    const result = validateIndexableRecord(indexable);
    expect(result.errors.some((e) => e.includes('body'))).toBe(false);
  });
});

describe('validateIndexableRecord — popularity score range', () => {
  it('catches popularityScore above 1', () => {
    const rec = makeEnrichedRecord();
    const indexable = { ...silverToIndexable(rec), popularityScore: 1.1 };
    const result = validateIndexableRecord(indexable);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('popularityScore'))).toBe(true);
  });

  it('catches popularityScore below 0', () => {
    const rec = makeEnrichedRecord();
    const indexable = { ...silverToIndexable(rec), popularityScore: -0.01 };
    const result = validateIndexableRecord(indexable);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('popularityScore'))).toBe(true);
  });
});
