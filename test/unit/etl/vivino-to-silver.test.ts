import { describe, expect, it } from 'vitest';
import {
  normalizeLabel,
  parseAlcohol,
  parseVarietal,
  cleanRegion,
  extractPriceUsd,
  transformRow,
  dedup,
  normalizePopularity,
} from '../../../scripts/etl/vivino-to-silver.js';
import type { BronzeRow } from '../../../scripts/etl/types.js';

describe('vivino-to-silver helpers', () => {
  describe('normalizeLabel', () => {
    it('removes producer duplication from start', () => {
      expect(normalizeLabel('Chateau Margaux Chateau Margaux 2015', 'Chateau Margaux', 2015))
        .toBe('Chateau Margaux 2015');
    });

    it('appends vintage if missing', () => {
      expect(normalizeLabel('Opus One', null, 2018)).toBe('Opus One 2018');
    });

    it('does not double-append vintage', () => {
      expect(normalizeLabel('Opus One 2018', null, 2018)).toBe('Opus One 2018');
    });

    it('collapses whitespace', () => {
      expect(normalizeLabel('  Opus   One  ', null, null)).toBe('Opus One');
    });
  });

  describe('parseAlcohol', () => {
    it('parses standard percentage', () => {
      expect(parseAlcohol('14%')).toBe(14);
      expect(parseAlcohol('13.5%')).toBe(13.5);
    });

    it('parses percentage with suffix', () => {
      expect(parseAlcohol('14.4% alc')).toBe(14.4);
    });

    it('returns null for missing/invalid', () => {
      expect(parseAlcohol(undefined)).toBeNull();
      expect(parseAlcohol('')).toBeNull();
      expect(parseAlcohol('not a percentage')).toBeNull();
    });

    it('rejects out-of-range values', () => {
      expect(parseAlcohol('30%')).toBeNull();
      expect(parseAlcohol('0%')).toBeNull();
    });

    // SCAN4-14: European decimal notation (comma as decimal separator)
    it('parses European decimal notation (comma as separator)', () => {
      expect(parseAlcohol('14,5%')).toBe(14.5);
      expect(parseAlcohol('13,8%')).toBe(13.8);
      expect(parseAlcohol('14,4% alc')).toBe(14.4);
    });
  });

  describe('parseVarietal', () => {
    it('splits comma-separated grapes and keeps only canonical (first) synonym per grape', () => {
      // Slash separates synonyms for the SAME grape — keep only the canonical (first) name.
      // "Shiraz/Syrah" → "Shiraz" (not two separate grapes).
      expect(parseVarietal('Grenache, Shiraz/Syrah')).toEqual(['Grenache', 'Shiraz']);
    });

    it('R-PARSE-VAR-01: single grape with synonym uses canonical name only', () => {
      // "Garnacha/Grenache" is one grape; "Garnacha" is canonical (first).
      expect(parseVarietal('Garnacha/Grenache')).toEqual(['Garnacha']);
    });

    it('R-PARSE-VAR-02: multiple grapes with synonyms produce distinct canonical names', () => {
      expect(parseVarietal('Garnacha/Grenache, Monastrell/Mourvedre')).toEqual([
        'Garnacha', 'Monastrell',
      ]);
    });

    it('R-PARSE-VAR-03: grape without synonym is unchanged', () => {
      expect(parseVarietal('Chardonnay')).toEqual(['Chardonnay']);
    });

    it('R-PARSE-VAR-04: multi-word grape name preserved when no slash', () => {
      expect(parseVarietal('Pinot Noir, Pinot Blanc')).toEqual(['Pinot Noir', 'Pinot Blanc']);
    });

    it('returns empty array for missing', () => {
      expect(parseVarietal(undefined)).toEqual([]);
      expect(parseVarietal('')).toEqual([]);
    });
  });

  describe('cleanRegion', () => {
    it('prefers winery_location when clean', () => {
      expect(cleanRegion('US / CA / Napa Valley', 'Napa Valley')).toBe('Napa Valley');
    });

    it('deduplicates repeated segments', () => {
      const result = cleanRegion(
        'United States / Horse Heaven Hills / Washington / Horse Heaven Hills',
        undefined,
      );
      // Should return last unique segment
      expect(result).toBe('Washington');
    });

    it('returns empty string for null region', () => {
      expect(cleanRegion(null, undefined)).toBe('');
    });
  });

  describe('extractPriceUsd', () => {
    it('converts EUR to USD using FX rate', () => {
      const result = extractPriceUsd(null, null, [
        { price: 100, currency: 'EUR' },
      ], undefined);
      expect(result).toBe(108); // EUR 100 × 1.08 rate = USD 108
    });

    it('takes median of multiple USD prices', () => {
      const result = extractPriceUsd(null, null, [
        { price: 10, currency: 'USD' },
        { price: 30, currency: 'USD' },
        { price: 20, currency: 'USD' },
      ], undefined);
      expect(result).toBe(20); // median of [10, 20, 30]
    });

    it('normalizes magnum prices to 750ml equivalent', () => {
      const result = extractPriceUsd(null, null, [
        { price: 100, currency: 'USD' },
      ], 1500);
      expect(result).toBe(50); // 100 * (750/1500) = 50
    });

    it('falls back to row price with currency conversion', () => {
      const result = extractPriceUsd(20, 'EUR', undefined, undefined);
      expect(result).toBe(21.6); // EUR 20 × 1.08 = USD 21.60
    });

    it('returns null when no price data', () => {
      expect(extractPriceUsd(null, null, undefined, undefined)).toBeNull();
    });

    it('returns null for unknown currency', () => {
      const result = extractPriceUsd(50, 'XYZ', undefined, undefined);
      expect(result).toBeNull();
    });

    it('handles single merchant price (no median needed)', () => {
      const result = extractPriceUsd(null, null, [
        { price: 42, currency: 'USD' },
      ], undefined);
      expect(result).toBe(42);
    });

    it('handles even-length price arrays (correct median)', () => {
      const result = extractPriceUsd(null, null, [
        { price: 10, currency: 'USD' },
        { price: 20, currency: 'USD' },
      ], undefined);
      expect(result).toBe(15); // (10+20)/2
    });

    it('skips merchant prices with unknown currency', () => {
      const result = extractPriceUsd(null, null, [
        { price: 100, currency: 'FAKE' },
      ], undefined);
      // Unknown currency merchants skipped, no USD fallback
      expect(result).toBeNull();
    });

    it('skips zero or negative merchant prices', () => {
      const result = extractPriceUsd(null, null, [
        { price: 0, currency: 'USD' },
        { price: -5, currency: 'USD' },
        { price: 25, currency: 'USD' },
      ], undefined);
      expect(result).toBe(25); // only valid price
    });

    it('normalizes 750ml bottles without change', () => {
      const result = extractPriceUsd(null, null, [
        { price: 50, currency: 'USD' },
      ], 750);
      expect(result).toBe(50); // 750ml = standard, no normalization
    });
  });

  describe('normalizePopularity', () => {
    it('returns empty array for empty input', () => {
      expect(normalizePopularity([])).toEqual([]);
    });

    it('handles all-zero ratings', () => {
      const records = [
        { ratingsCount: 0 },
        { ratingsCount: 0 },
      ] as Parameters<typeof normalizePopularity>[0];
      const result = normalizePopularity(records);
      expect(result.every((r) => r.popularityScore === 0)).toBe(true);
    });

    it('normalizes to [0, 1] range', () => {
      const records = [
        { ratingsCount: 0 },
        { ratingsCount: 50 },
        { ratingsCount: 1000 },
      ] as Parameters<typeof normalizePopularity>[0];
      const result = normalizePopularity(records);
      expect(result[0]!.popularityScore).toBe(0);
      expect(result[2]!.popularityScore).toBe(1);
      expect(result[1]!.popularityScore).toBeGreaterThan(0);
      expect(result[1]!.popularityScore).toBeLessThan(1);
    });

    it('caps at 1.0 even with floating point edge cases', () => {
      const records = [
        { ratingsCount: 999999 },
        { ratingsCount: 1000000 },
      ] as Parameters<typeof normalizePopularity>[0];
      const result = normalizePopularity(records);
      expect(result[0]!.popularityScore).toBeLessThanOrEqual(1.0);
      expect(result[1]!.popularityScore).toBe(1.0);
    });
  });

  describe('transformRow', () => {
    const baseRow: BronzeRow = {
      id: 1,
      external_id: 'test-123',
      display_name: 'Test Wine 2020',
      producer: 'Test Winery',
      vintage_year: 2020,
      region: 'Napa Valley',
      country: 'USA',
      wine_style: 'Red Wine',
      rating: 4.2,
      price: 25,
      currency: 'USD',
      scraped_at: '2024-01-01T00:00:00Z',
      source_url: null,
      payload: null,
    };

    it('transforms a valid row', () => {
      const result = transformRow(baseRow);
      expect(result).not.toBeNull();
      expect(result!.producer).toBe('Test Winery');
      expect(result!.vintageYear).toBe(2020);
      expect(result!.wineType).toBe('red');
    });

    it('returns null for missing external_id', () => {
      const result = transformRow({ ...baseRow, external_id: '' });
      expect(result).toBeNull();
    });

    it('returns null for missing producer', () => {
      const result = transformRow({ ...baseRow, producer: null, payload: null });
      expect(result).toBeNull();
    });

    it('body defaults to fallback when taste.structure absent', () => {
      const result = transformRow(baseRow);
      expect(result).not.toBeNull();
      // Without payload.taste.structure, falls back to taste_profile or 0.5
      expect(result!.body).toBeGreaterThanOrEqual(0);
      expect(result!.body).toBeLessThanOrEqual(1);
    });

    // ── Bug fix regression: fizziness threshold scale (Bug 1) ─────────────────
    // Vivino taste.structure values are on a 0–5 integer scale.
    // The threshold for "at least slightly sparkling" is 1.5 (= 0.3 × 5).
    // Previously the condition only fired for base==='red'; sparkling whites/rosés
    // were silently misclassified. After the fix the condition fires for any
    // non-sparkling base type.

    it('classifies red wine with fizziness just above threshold (>1.5 on 0-5 scale) as sparkling', () => {
      const row: BronzeRow = {
        ...baseRow,
        wine_style: 'Red Wine', // detectWineType → 'red'
        payload: {
          taste: {
            structure: {
              // fizziness=2 is above 1.5 threshold → sparkling override must fire
              fizziness: 2,
              acidity: 3,
              tannin: 1,
              sweetness: 1,
              intensity: 3,
            },
          },
        },
      };
      const result = transformRow(row);
      expect(result).not.toBeNull();
      expect(result!.wineType).toBe('sparkling');
    });

    it('does NOT classify red wine with fizziness at or below threshold (≤1.5) as sparkling', () => {
      const row: BronzeRow = {
        ...baseRow,
        wine_style: 'Red Wine',
        payload: {
          taste: {
            structure: {
              fizziness: 1, // ≤1.5 → still red
              acidity: 3,
              tannin: 4,
              sweetness: 1,
              intensity: 4,
            },
          },
        },
      };
      const result = transformRow(row);
      expect(result).not.toBeNull();
      expect(result!.wineType).toBe('red');
    });

    it('classifies white wine with high fizziness as sparkling (regression: was silently skipped)', () => {
      // Before fix: condition was `base === 'red'` only — white wines with high
      // fizziness (e.g. Blanc-de-Blancs Champagne detected as white) were missed.
      const row: BronzeRow = {
        ...baseRow,
        wine_style: 'White Wine', // detectWineType → 'white'
        payload: {
          taste: {
            structure: {
              fizziness: 4, // very fizzy — clearly sparkling
              acidity: 4,
              tannin: 0,
              sweetness: 1,
              intensity: 3,
            },
          },
        },
      };
      const result = transformRow(row);
      expect(result).not.toBeNull();
      expect(result!.wineType).toBe('sparkling');
    });

    it('preserves sparkling classification even when fizziness is high (no double-override)', () => {
      // If detectWineType already returns 'sparkling', fizziness guard must NOT
      // re-apply (it checks base !== 'sparkling').
      const row: BronzeRow = {
        ...baseRow,
        wine_style: 'Sparkling Wine',
        payload: {
          taste: {
            structure: {
              fizziness: 5,
              acidity: 3,
              tannin: 0,
              sweetness: 2,
              intensity: 4,
            },
          },
        },
      };
      const result = transformRow(row);
      expect(result).not.toBeNull();
      expect(result!.wineType).toBe('sparkling');
    });
  });

  describe('dedup', () => {
    it('deduplicates by (externalId, vintageYear)', () => {
      const records = [
        { externalId: 'a', vintageYear: 2020, ratingsCount: 10, scrapedAt: '2024-01-01', searchTextEn: 'test' },
        { externalId: 'a', vintageYear: 2020, ratingsCount: 20, scrapedAt: '2024-01-01', searchTextEn: 'test longer' },
      ] as Parameters<typeof dedup>[0];
      const result = dedup(records);
      expect(result).toHaveLength(1);
      expect(result[0]!.ratingsCount).toBe(20); // higher ratings count wins on same timestamp
    });

    it('keeps records with different vintages', () => {
      const records = [
        { externalId: 'a', vintageYear: 2019, ratingsCount: 10, scrapedAt: null, searchTextEn: '' },
        { externalId: 'a', vintageYear: 2020, ratingsCount: 10, scrapedAt: null, searchTextEn: '' },
      ] as Parameters<typeof dedup>[0];
      const result = dedup(records);
      expect(result).toHaveLength(2);
    });

    // ── Round 2 audit regression: NaN-safe dedup ──────────────────────────────
    it('handles invalid scrapedAt dates without dropping records', () => {
      const records = [
        { externalId: 'a', vintageYear: 2020, ratingsCount: 10, scrapedAt: 'not-a-date', searchTextEn: 'first' },
        { externalId: 'a', vintageYear: 2020, ratingsCount: 20, scrapedAt: '2024-06-01', searchTextEn: 'second' },
      ] as Parameters<typeof dedup>[0];
      const result = dedup(records);
      expect(result).toHaveLength(1);
      // Valid date should win over invalid
      expect(result[0]!.ratingsCount).toBe(20);
    });
  });
});
