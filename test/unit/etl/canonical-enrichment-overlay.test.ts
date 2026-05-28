import { describe, expect, it } from 'vitest';

import {
  applyCanonicalEnrichmentOverlay,
  reconcileCanonicalEnrichmentRecords,
} from '../../../scripts/etl/canonical-enrichment-overlay.js';
import type { EnrichedSilverRecord } from '../../../scripts/etl/types.js';

function makeRecord(
  overrides: Partial<EnrichedSilverRecord> = {},
): EnrichedSilverRecord {
  return {
    sourceId: 'vivino-test',
    externalId: 'ext-1',
    canonicalLabel: 'Test Wine 2020',
    producer: 'Test Producer',
    vintageYear: 2020,
    country: 'France',
    region: 'Burgundy',
    appellation: null,
    wineType: 'red',
    grapePrimary: null,
    grapes: [],
    body: 0.5,
    sweetness: 0.2,
    acidity: 0.6,
    tannin: 0.5,
    pairingTags: [],
    flavorProfiles: [],
    searchTextEn: 'test wine',
    ratingAvg: 4.1,
    ratingsCount: 42,
    priceUsd: 55,
    popularityScore: 0.4,
    scrapedAt: null,
    alcoholPct: null,
    producerPrestige: null,
    isTopRated: false,
    aliases: {
      proposed: [],
      identitySafeProjection: [],
      noisyRecallProjection: [],
    },
    ...overrides,
  };
}

describe('canonical enrichment overlay', () => {
  it('hydrates structured grape fields from the overlay row', () => {
    const record = makeRecord();
    const overlaid = applyCanonicalEnrichmentOverlay(record, new Map([
      ['vivino-test', makeRecord({
        country: 'Italy',
        region: 'Italy / Toscana / Central Italy / Toscana',
        appellation: 'Toscana',
        regionHierarchy: ['Italy', 'Toscana', 'Central Italy'],
        grapePrimary: 'Cabernet Sauvignon',
        grapes: ['Cabernet Sauvignon'],
        pairingTags: ['beef'],
        flavorProfiles: ['blackcurrant'],
        searchTextKo: '까베르네 소비뇽 프랑스 레드',
      })],
    ]));

    expect(overlaid.country).toBe('Italy');
    expect(overlaid.region).toBe('Italy / Toscana / Central Italy / Toscana');
    expect(overlaid.appellation).toBe('Toscana');
    expect(overlaid.regionHierarchy).toEqual(['Italy', 'Toscana', 'Central Italy']);
    expect(overlaid.grapePrimary).toBe('Cabernet Sauvignon');
    expect(overlaid.grapes).toEqual(['Cabernet Sauvignon']);
    expect(overlaid.pairingTags).toEqual(['beef']);
    expect(overlaid.flavorProfiles).toEqual(['blackcurrant']);
    expect(overlaid.searchTextKo).toBe('까베르네 소비뇽 프랑스 레드');
  });

  it('leaves unmatched records untouched', () => {
    const record = makeRecord({ sourceId: 'synth-123' });
    const overlaid = applyCanonicalEnrichmentOverlay(record, new Map([
      ['vivino-test', makeRecord({ grapePrimary: 'Merlot', grapes: ['Merlot'] })],
    ]));

    expect(overlaid).toEqual(record);
  });

  it('reconciles a batch while preserving record order', () => {
    const records = [
      makeRecord({ sourceId: 'vivino-a', canonicalLabel: 'A', grapePrimary: null, grapes: [] }),
      makeRecord({ sourceId: 'synth-b', canonicalLabel: 'B', grapePrimary: 'Glera', grapes: ['Glera'] }),
    ];
    const reconciled = reconcileCanonicalEnrichmentRecords(records, new Map([
      ['vivino-a', makeRecord({
        sourceId: 'vivino-a',
        canonicalLabel: 'A',
        grapePrimary: 'Pinot Noir',
        grapes: ['Pinot Noir'],
      })],
    ]));

    expect(reconciled.map((record) => record.sourceId)).toEqual(['vivino-a', 'synth-b']);
    expect(reconciled[0]?.grapePrimary).toBe('Pinot Noir');
    expect(reconciled[1]?.grapePrimary).toBe('Glera');
  });
});
