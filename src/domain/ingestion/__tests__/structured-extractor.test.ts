import { describe, expect, it } from 'vitest';

import type { RawSourceRecord } from '../model/raw-source-record.js';
import { extract } from '../service/structured-extractor.js';

function makeRecord(overrides: Partial<RawSourceRecord> = {}): RawSourceRecord {
  return {
    sourceRecordId: 'test-001',
    sourceSystem: 'vivino',
    sourceType: 'marketplace',
    rawTitle: 'Château Margaux 2015',
    ingestionTimestamp: new Date('2024-01-01'),
    ...overrides,
  };
}

describe('structured-extractor / extract', () => {
  // ── 1. Basic extraction: full record with all fields ──────────────────────
  it('extracts all fields when full record is provided and confidence is 1.0', () => {
    const record = makeRecord({
      rawTitle: 'Château Margaux Grand Vin 2015',
      producerText: 'Château Margaux',
      regionText: 'Margaux, Bordeaux',
      grapeText: 'Cabernet Sauvignon, Merlot, Petit Verdot',
      vintageText: '2015',
      volumeText: '750ml',
    });

    const result = extract(record);

    expect(result.sourceRecordId).toBe('test-001');
    expect(result.candidateId).toBeTruthy();
    expect(result.extracted.producer).toBeDefined();
    expect(result.extracted.wineLabel).toBeDefined();
    expect(result.extracted.vintage).toBe(2015);
    expect(result.extracted.region).toBeDefined();
    expect(result.extracted.grape).toBeDefined();
    expect(result.extracted.grape!.length).toBeGreaterThanOrEqual(2);
    expect(result.extracted.volumeMl).toBe(750);
    expect(result.parsingConfidence).toBe(1.0);
  });

  // ── 2. Producer extraction from title via " - " delimiter ─────────────────
  it('extracts producer from title when it contains " - " delimiter', () => {
    const record = makeRecord({
      rawTitle: 'Domaine Leroy - Chambertin Grand Cru 2017',
    });

    const result = extract(record);

    expect(result.extracted.producer).toBe('Domaine Leroy');
  });

  // ── 3. Producer extraction from dedicated producerText field ───────────────
  it('uses producerText directly when provided', () => {
    const record = makeRecord({
      rawTitle: 'Chambertin Grand Cru 2017',
      producerText: 'Domaine Leroy',
    });

    const result = extract(record);

    expect(result.extracted.producer).toBe('Domaine Leroy');
  });

  // ── 4. Wine label extraction: removes producer prefix and vintage ─────────
  it('removes producer prefix and vintage from title to derive wineLabel', () => {
    const record = makeRecord({
      rawTitle: 'Château Margaux 2015',
      producerText: 'Château Margaux',
      vintageText: '2015',
    });

    const result = extract(record);

    // Label should not contain the producer prefix or the vintage year
    if (result.extracted.wineLabel !== undefined) {
      expect(result.extracted.wineLabel).not.toContain('2015');
      expect(result.extracted.wineLabel.toLowerCase()).not.toMatch(
        /^château margaux/,
      );
    }
  });

  // ── 5. Vintage from dedicated field ───────────────────────────────────────
  it('extracts vintage from vintageText when provided', () => {
    const record = makeRecord({
      rawTitle: 'Some Wine',
      vintageText: '2018',
    });

    const result = extract(record);

    expect(result.extracted.vintage).toBe(2018);
  });

  // ── 6. Vintage fallback from title ────────────────────────────────────────
  it('falls back to extracting vintage from rawTitle when vintageText is absent', () => {
    const record = makeRecord({
      rawTitle: 'Opus One 2020',
    });

    const result = extract(record);

    expect(result.extracted.vintage).toBe(2020);
  });

  // ── 7. Volume from dedicated field ────────────────────────────────────────
  it('extracts volume from volumeText when provided', () => {
    const record = makeRecord({
      rawTitle: 'Some Wine',
      volumeText: '750ml',
    });

    const result = extract(record);

    expect(result.extracted.volumeMl).toBe(750);
  });

  it('handles litre volume text', () => {
    const record = makeRecord({
      rawTitle: 'Magnum Wine',
      volumeText: '1.5L',
    });

    const result = extract(record);

    expect(result.extracted.volumeMl).toBe(1500);
  });

  // ── 8. Volume fallback from title ─────────────────────────────────────────
  it('falls back to extracting volume from rawTitle when volumeText is absent', () => {
    const record = makeRecord({
      rawTitle: 'Wine 750ml',
    });

    const result = extract(record);

    expect(result.extracted.volumeMl).toBe(750);
  });

  // ── 9. Grape extraction ───────────────────────────────────────────────────
  it('splits comma-separated grapeText into individual varieties', () => {
    const record = makeRecord({
      grapeText: 'Cabernet Sauvignon, Merlot',
    });

    const result = extract(record);

    expect(result.extracted.grape).toBeDefined();
    expect(result.extracted.grape).toContain('Cabernet Sauvignon');
    expect(result.extracted.grape).toContain('Merlot');
    expect(result.extracted.grape!.length).toBe(2);
  });

  it('splits semicolon-separated grapeText', () => {
    const record = makeRecord({
      grapeText: 'Pinot Noir; Chardonnay; Gamay',
    });

    const result = extract(record);

    expect(result.extracted.grape).toBeDefined();
    expect(result.extracted.grape!.length).toBe(3);
  });

  // ── 10. Empty input ───────────────────────────────────────────────────────
  it('handles empty rawTitle with low confidence', () => {
    const record = makeRecord({
      rawTitle: '',
    });

    const result = extract(record);

    expect(result.normalizedTitle).toBe('');
    expect(result.parsingConfidence).toBeLessThan(0.5);
  });

  // ── 11. Noise stripping ───────────────────────────────────────────────────
  it('strips noise tokens and populates noiseFlags', () => {
    const record = makeRecord({
      rawTitle: 'sale Château Margaux 2015 gift box',
    });

    const result = extract(record);

    // The noise tokens should be detected and stripped
    expect(result.noiseFlags.length).toBeGreaterThan(0);
    expect(result.noiseFlags).toContain('sale');
    expect(result.noiseFlags).toContain('gift box');
    // The cleaned title should not contain the stripped noise tokens
    expect(result.normalizedTitle.toLowerCase()).not.toContain('gift box');
  });

  it('detects "sale" as a noise token', () => {
    const record = makeRecord({
      rawTitle: 'sale Château Margaux 2015',
    });

    const result = extract(record);

    expect(result.noiseFlags).toContain('sale');
  });

  // ── 12. Korean title ──────────────────────────────────────────────────────
  it('applies Korean normalization when locale is "ko"', () => {
    const record = makeRecord({
      rawTitle: '샤또\u3000마고\u30002015',
      locale: 'ko',
    });

    const result = extract(record);

    // Full-width spaces (U+3000) should be converted to ASCII spaces
    expect(result.normalizedTitle).not.toContain('\u3000');
    expect(result.extracted.vintage).toBe(2015);
  });

  it('applies Korean normalization for ko-KR locale', () => {
    const record = makeRecord({
      rawTitle: '오퍼스\u3000원\u30002020',
      locale: 'ko-KR',
    });

    const result = extract(record);

    expect(result.normalizedTitle).not.toContain('\u3000');
  });

  // ── 13. Alias generation ──────────────────────────────────────────────────
  it('generates aliases including normalized title', () => {
    const record = makeRecord({
      rawTitle: 'Château Margaux 2015',
      producerText: 'Château Margaux',
    });

    const result = extract(record);

    // Should include the normalized title at minimum
    expect(result.aliasCandidates.length).toBeGreaterThanOrEqual(1);
    expect(result.aliasCandidates).toContain(result.normalizedTitle);
  });

  it('generates producer + label alias when both are extracted', () => {
    const record = makeRecord({
      rawTitle: 'Domaine Leroy - Chambertin Grand Cru 2017',
    });

    const result = extract(record);
    const { producer, wineLabel } = result.extracted;

    if (producer !== undefined && wineLabel !== undefined) {
      expect(result.aliasCandidates).toContain(`${producer} ${wineLabel}`);
    }
  });

  it('generates producer + label + vintage alias when all three are extracted', () => {
    const record = makeRecord({
      rawTitle: 'Domaine Leroy - Chambertin Grand Cru 2017',
    });

    const result = extract(record);
    const { producer, wineLabel, vintage } = result.extracted;

    if (
      producer !== undefined &&
      wineLabel !== undefined &&
      vintage !== undefined
    ) {
      expect(result.aliasCandidates).toContain(
        `${producer} ${wineLabel} ${String(vintage)}`,
      );
    }
  });

  // ── 14. Parsing confidence proportional to extracted field count ───────────
  it('computes confidence as extractedCount / 6', () => {
    // Provide only 2 extractable fields: vintage (from title) + producer (from producerText)
    const record = makeRecord({
      rawTitle: 'Some Wine',
      producerText: 'Test Producer',
    });

    const result = extract(record);

    // producer + wineLabel should be extracted (wineLabel derived from title minus producer)
    // Count actual extracted fields
    let count = 0;
    if (result.extracted.producer !== undefined) count++;
    if (result.extracted.wineLabel !== undefined) count++;
    if (result.extracted.vintage !== undefined) count++;
    if (result.extracted.region !== undefined) count++;
    if (result.extracted.grape !== undefined && result.extracted.grape.length > 0) count++;
    if (result.extracted.volumeMl !== undefined) count++;

    expect(result.parsingConfidence).toBeCloseTo(count / 6, 5);
  });

  it('returns confidence 0 when no fields can be extracted', () => {
    const record = makeRecord({
      rawTitle: '',
    });

    const result = extract(record);

    expect(result.parsingConfidence).toBe(0);
  });

  // ── 15. Contamination detection ───────────────────────────────────────────
  it('flags marketplace contamination when rawTitle diverges heavily from canonical label', () => {
    const record = makeRecord({
      rawTitle:
        'Château Margaux 750ml Gift Box Set Sale Best Premium Free Shipping Special Offer Hot Deal Bundle Imported Authentic',
      producerText: 'Château Margaux',
      vintageText: '2015',
    });

    const result = extract(record);

    expect(result.noiseFlags).toContain('marketplace_contamination_suspected');
  });

  it('does not flag contamination on clean titles', () => {
    const record = makeRecord({
      rawTitle: 'Château Margaux 2015',
      producerText: 'Château Margaux',
    });

    const result = extract(record);

    expect(result.noiseFlags).not.toContain(
      'marketplace_contamination_suspected',
    );
  });

  // ── Edge cases ────────────────────────────────────────────────────────────
  it('returns a unique candidateId for each call', () => {
    const record = makeRecord();
    const a = extract(record);
    const b = extract(record);

    expect(a.candidateId).not.toBe(b.candidateId);
  });

  it('handles record with only rawTitle and no optional fields', () => {
    const record = makeRecord({
      rawTitle: 'Penfolds Grange 2018',
    });

    const result = extract(record);

    expect(result.normalizedTitle).toBeTruthy();
    expect(result.extracted.vintage).toBe(2018);
    expect(result.parsingConfidence).toBeGreaterThan(0);
  });

  it('handles grapeText with slash separator', () => {
    const record = makeRecord({
      grapeText: 'Syrah/Grenache/Mourvèdre',
    });

    const result = extract(record);

    expect(result.extracted.grape).toBeDefined();
    expect(result.extracted.grape!.length).toBe(3);
  });

  it('ignores empty grapeText', () => {
    const record = makeRecord({
      grapeText: '   ',
    });

    const result = extract(record);

    expect(result.extracted.grape).toBeUndefined();
  });

  it('ignores empty producerText and falls through to title heuristic', () => {
    const record = makeRecord({
      rawTitle: 'Domaine Leflaive - Puligny-Montrachet 2019',
      producerText: '   ',
    });

    const result = extract(record);

    expect(result.extracted.producer).toBe('Domaine Leflaive');
  });

  it('returns undefined producer when title has no delimiter and no producerText', () => {
    const record = makeRecord({
      rawTitle: 'Chambertin Grand Cru 2017',
    });

    const result = extract(record);

    expect(result.extracted.producer).toBeUndefined();
  });

  it('handles centilitre volume', () => {
    const record = makeRecord({
      rawTitle: 'Some Wine',
      volumeText: '75cl',
    });

    const result = extract(record);

    expect(result.extracted.volumeMl).toBe(750);
  });

  // ── Round 2 audit regression tests ────────────────────────────────────────
  it('filters out percentage strings from grapes', () => {
    const record = makeRecord({ grapeText: 'Cabernet Sauvignon; 60%, Merlot; 40%' });
    const result = extract(record);
    expect(result.extracted.grape).toEqual(['Cabernet Sauvignon', 'Merlot']);
  });

  it('does not extract vintage year as volume from title', () => {
    const record = makeRecord({ rawTitle: 'Barolo 2015 Limited Edition' });
    const result = extract(record);
    // 2015 should be extracted as vintage, NOT as 2015L volume
    expect(result.extracted.vintage).toBe(2015);
    expect(result.extracted.volumeMl).toBeUndefined();
  });
});
