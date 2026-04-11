import { describe, expect, it } from 'vitest';
import { generateAliases } from '../../../scripts/etl/generate-aliases.js';
import type { SilverWineRecord } from '../../../scripts/etl/types.js';

function makeSilverRecord(overrides: Partial<SilverWineRecord> = {}): SilverWineRecord {
  return {
    sourceId: 'test-id',
    externalId: 'ext-1',
    canonicalLabel: 'Château Margaux 2015',
    producer: 'Château Margaux',
    vintageYear: 2015,
    country: 'France',
    region: 'Bordeaux',
    appellation: null,
    wineType: 'red',
    grapePrimary: 'Cabernet Sauvignon',
    grapes: ['Cabernet Sauvignon', 'Merlot'],
    body: 0.7,
    sweetness: 0.1,
    acidity: 0.5,
    tannin: 0.8,
    pairingTags: ['beef', 'lamb'],
    flavorProfiles: ['black fruit', 'oak'],
    searchTextEn: 'A complex red wine with notes of blackcurrant and cedar.',
    ratingAvg: 4.5,
    ratingsCount: 5000,
    priceUsd: 350,
    priceBand: 'premium',
    popularityScore: 0.9,
    scrapedAt: '2024-01-01T00:00:00Z',
    alcoholPct: 13.5,
    producerPrestige: 0.9,
    isTopRated: true,
    ...overrides,
  };
}

describe('generateAliases', () => {
  it('generates producer identity alias', () => {
    const result = generateAliases(makeSilverRecord());
    const producerAlias = result.proposed.find(
      (a) => a.source === 'rule:producer_identity_v1',
    );
    expect(producerAlias).toBeDefined();
    expect(producerAlias!.value).toBe('Château Margaux');
    expect(producerAlias!.confidencePrior).toBe(0.95);
  });

  it('generates accent-folded alias when accents present', () => {
    const result = generateAliases(makeSilverRecord());
    const foldedAlias = result.proposed.find(
      (a) => a.source === 'rule:accent_fold_v1',
    );
    expect(foldedAlias).toBeDefined();
    expect(foldedAlias!.value).toBe('Chateau Margaux 2015');
  });

  it('generates short name from producer with chateau prefix', () => {
    const result = generateAliases(makeSilverRecord());
    const shortAlias = result.proposed.find(
      (a) => a.source === 'rule:short_name_v1',
    );
    expect(shortAlias).toBeDefined();
    expect(shortAlias!.value).toBe('Margaux');
    expect(shortAlias!.needsReview).toBe(true);
  });

  it('generates no-vintage alias when label differs from producer', () => {
    // "Château Margaux 2015" without vintage = "Château Margaux" = producer → skipped
    // Use a label that differs from producer after removing vintage
    const result = generateAliases(makeSilverRecord({
      canonicalLabel: 'Château Margaux Grand Vin 2015',
    }));
    const noVintage = result.proposed.find(
      (a) => a.source === 'rule:no_vintage_v1',
    );
    expect(noVintage).toBeDefined();
    expect(noVintage!.value).not.toContain('2015');
    expect(noVintage!.value).toBe('Château Margaux Grand Vin');
  });

  it('generates region+grape recall alias', () => {
    const result = generateAliases(makeSilverRecord());
    const regionGrape = result.proposed.find(
      (a) => a.source === 'rule:region_grape_v1',
    );
    expect(regionGrape).toBeDefined();
    expect(regionGrape!.value).toBe('Bordeaux Cabernet Sauvignon');
  });

  it('projects high-confidence non-review aliases to identitySafe', () => {
    const result = generateAliases(makeSilverRecord());
    expect(result.identitySafeProjection.length).toBeGreaterThan(0);
    // Producer identity (0.95, no review) should be in identity-safe
    expect(result.identitySafeProjection).toContain('Château Margaux');
  });

  it('projects low-confidence or needs-review aliases to noisyRecall', () => {
    const result = generateAliases(makeSilverRecord());
    // Short name (0.40, needs review) should be noisy
    expect(result.noisyRecallProjection).toContain('Margaux');
    // Region+grape (0.25, needs review) should be noisy
    expect(result.noisyRecallProjection).toContain('Bordeaux Cabernet Sauvignon');
  });

  it('handles record without vintage', () => {
    const result = generateAliases(makeSilverRecord({ vintageYear: null }));
    const noVintage = result.proposed.find(
      (a) => a.source === 'rule:no_vintage_v1',
    );
    expect(noVintage).toBeUndefined();
  });

  it('handles record without grapes or region', () => {
    const result = generateAliases(
      makeSilverRecord({ grapePrimary: null, region: '' }),
    );
    const regionGrape = result.proposed.find(
      (a) => a.source === 'rule:region_grape_v1',
    );
    expect(regionGrape).toBeUndefined();
  });

  it('strips trailing "Winery" suffix in short name', () => {
    const result = generateAliases(
      makeSilverRecord({
        producer: 'Opus One Winery',
        canonicalLabel: 'Opus One Winery 2018',
      }),
    );
    const shortAlias = result.proposed.find(
      (a) => a.source === 'rule:short_name_v1',
    );
    expect(shortAlias).toBeDefined();
    expect(shortAlias!.value).toBe('Opus One');
  });

  // SCAN4-15: \b → Unicode-safe boundary regression
  // Vintage year should be removed from no-vintage alias without corrupting
  // adjacent Korean characters or multi-digit substrings like "20150".
  describe('no-vintage alias — Unicode-safe year boundary (SCAN4-15)', () => {
    it('removes 4-digit vintage year from label', () => {
      const result = generateAliases(makeSilverRecord({
        canonicalLabel: 'Château Margaux Grand Vin 2015',
        vintageYear: 2015,
      }));
      const noVintage = result.proposed.find((a) => a.source === 'rule:no_vintage_v1');
      expect(noVintage?.value).toBe('Château Margaux Grand Vin');
    });

    it('does not remove year substring embedded in longer number (e.g. 20150)', () => {
      // "도멘 2015 셀러" → vintage should be stripped correctly,
      // but a label with "20150" should not have "2015" stripped mid-number.
      const result = generateAliases(makeSilverRecord({
        canonicalLabel: 'Opus One 20150 Special',
        vintageYear: 2015,
        producer: 'Opus One',
      }));
      const noVintage = result.proposed.find((a) => a.source === 'rule:no_vintage_v1');
      // "2015" embedded in "20150" must NOT be removed
      expect(noVintage?.value).toContain('20150');
    });

    it('handles Korean label with vintage year adjacent to Hangul', () => {
      // Korean wine label: "보르도 레드 2015" — year should be removed cleanly
      const result = generateAliases(makeSilverRecord({
        canonicalLabel: '보르도 레드 2015',
        producer: '보르도 와이너리',
        vintageYear: 2015,
      }));
      const noVintage = result.proposed.find((a) => a.source === 'rule:no_vintage_v1');
      expect(noVintage?.value).toBe('보르도 레드');
    });
  });
});

describe('extractShortName NFC normalization', () => {
  // R-NFC-GA-SHORT-01: extractShortName must NFC-normalize input before prefix matching.
  // CHATEAU_PREFIXES entries are NFC (e.g. 'château'). If the producer name arrives as
  // NFD (U+0065 + combining caron), the startsWith() comparison silently returns false,
  // and no short-name alias is generated. After the fix, NFC normalization in
  // extractShortName ensures NFD inputs match NFC prefixes.
  it('R-NFC-GA-SHORT-01: NFD-decomposed "Château" producer still generates short-name alias', () => {
    const nfdProducer = 'Château'.normalize('NFD') + ' Margaux'; // e.g. "Cha\u0302teau Margaux"
    const result = generateAliases(makeSilverRecord({
      producer: nfdProducer,
      canonicalLabel: nfdProducer + ' 2015',
      vintageYear: 2015,
    }));
    const shortAlias = result.proposed.find((a) => a.source === 'rule:short_name_v1');
    // Without NFC in extractShortName, shortAlias would be undefined
    expect(shortAlias).toBeDefined();
    expect(shortAlias?.value).toBe('Margaux');
  });

  it('R-NFC-GA-SHORT-02: NFC "Château" producer generates short-name alias (regression check)', () => {
    const result = generateAliases(makeSilverRecord({
      producer: 'Château Margaux',
      canonicalLabel: 'Château Margaux 2015',
      vintageYear: 2015,
    }));
    const shortAlias = result.proposed.find((a) => a.source === 'rule:short_name_v1');
    expect(shortAlias).toBeDefined();
    expect(shortAlias?.value).toBe('Margaux');
  });
});
