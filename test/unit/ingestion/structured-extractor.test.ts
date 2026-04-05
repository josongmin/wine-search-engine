import { describe, it, expect } from 'vitest';
import { extract } from '../../../src/domain/ingestion/service/structured-extractor.js';
import type { RawSourceRecord } from '../../../src/domain/ingestion/model/raw-source-record.js';

// ── Helper ─────────────────────────────────────────────────────────────────────

function makeRawRecord(overrides: Partial<RawSourceRecord> = {}): RawSourceRecord {
  return {
    sourceRecordId: 'src-001',
    sourceSystem: 'test-system',
    sourceType: 'catalog',
    rawTitle: 'Test Wine',
    ingestionTimestamp: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('structured-extractor: extract()', () => {
  // 1. producerText → extracted.producer is set
  it('record with producerText sets extracted.producer', () => {
    const record = makeRawRecord({ producerText: 'Opus One Winery' });
    const candidate = extract(record);
    expect(candidate.extracted.producer).toBeDefined();
    expect(candidate.extracted.producer).toBeTruthy();
  });

  // 2. title with no producerText → candidateId is a non-empty string
  it('candidateId is a non-empty string even without producerText', () => {
    const record = makeRawRecord({ rawTitle: 'Château Margaux 2015' });
    const candidate = extract(record);
    expect(typeof candidate.candidateId).toBe('string');
    expect(candidate.candidateId.length).toBeGreaterThan(0);
  });

  // 3. Vintage 2018 in title → extracted.vintage = 2018
  it('extracts vintage 2018 from title', () => {
    const record = makeRawRecord({ rawTitle: 'Opus One 2018' });
    const candidate = extract(record);
    expect(candidate.extracted.vintage).toBe(2018);
  });

  // 4. Vintage 1850 in title → valid (within [1800, 2030])
  it('extracts vintage 1850 from title (valid historical year)', () => {
    const record = makeRawRecord({ rawTitle: 'Chateau Latour 1850' });
    const candidate = extract(record);
    expect(candidate.extracted.vintage).toBe(1850);
  });

  // 5. Year 2150 → out of [1800, 2030] range → vintage = undefined
  it('year 2150 is out of range → extracted.vintage = undefined', () => {
    const record = makeRawRecord({ rawTitle: 'Future Wine 2150' });
    const candidate = extract(record);
    expect(candidate.extracted.vintage).toBeUndefined();
  });

  // 6. No year in title → extracted.vintage = undefined
  it('no year in title → extracted.vintage = undefined', () => {
    const record = makeRawRecord({ rawTitle: 'Napa Valley Cabernet Sauvignon' });
    const candidate = extract(record);
    expect(candidate.extracted.vintage).toBeUndefined();
  });

  // 7. sourceRecordId matches input record
  it('sourceRecordId matches the input record', () => {
    const record = makeRawRecord({ sourceRecordId: 'my-record-xyz' });
    const candidate = extract(record);
    expect(candidate.sourceRecordId).toBe('my-record-xyz');
  });

  // 8. Two calls with same input → different candidateIds (nanoid)
  it('two calls with same input produce different candidateIds', () => {
    const record = makeRawRecord({ rawTitle: 'Opus One 2018' });
    const c1 = extract(record);
    const c2 = extract(record);
    expect(c1.candidateId).not.toBe(c2.candidateId);
  });

  // 9. Complete fields → parsingConfidence > 0.5
  it('record with complete fields has parsingConfidence > 0.5', () => {
    const record = makeRawRecord({
      rawTitle: 'Opus One Winery Opus One 2018',
      producerText: 'Opus One Winery',
      vintageText: '2018',
      regionText: 'Napa Valley',
      grapeText: 'Cabernet Sauvignon',
      volumeText: '750ml',
    });
    const candidate = extract(record);
    expect(candidate.parsingConfidence).toBeGreaterThan(0.5);
  });

  // 10. Only rawTitle → lower parsingConfidence than complete record
  it('record with only rawTitle has lower confidence than a complete record', () => {
    const titleOnlyRecord = makeRawRecord({ rawTitle: 'Some Wine' });
    const completeRecord = makeRawRecord({
      rawTitle: 'Opus One Winery Opus One 2018',
      producerText: 'Opus One Winery',
      vintageText: '2018',
      regionText: 'Napa Valley',
      grapeText: 'Cabernet Sauvignon',
      volumeText: '750ml',
    });
    const titleOnly = extract(titleOnlyRecord);
    const complete = extract(completeRecord);
    expect(titleOnly.parsingConfidence).toBeLessThan(complete.parsingConfidence);
  });

  // 11. normalizedTitle is non-empty for non-empty rawTitle
  it('normalizedTitle is non-empty for a non-empty rawTitle', () => {
    const record = makeRawRecord({ rawTitle: 'Château Margaux 2015' });
    const candidate = extract(record);
    expect(typeof candidate.normalizedTitle).toBe('string');
    expect(candidate.normalizedTitle.length).toBeGreaterThan(0);
  });

  // 12. aliasCandidates is a non-empty array for a well-formed record
  it('aliasCandidates is non-empty for a well-formed record', () => {
    const record = makeRawRecord({
      rawTitle: 'Opus One Winery Opus One 2018',
      producerText: 'Opus One Winery',
      vintageText: '2018',
    });
    const candidate = extract(record);
    expect(Array.isArray(candidate.aliasCandidates)).toBe(true);
    expect(candidate.aliasCandidates.length).toBeGreaterThan(0);
  });

  // 13. noiseFlags is an array (may be empty)
  it('noiseFlags is an array', () => {
    const record = makeRawRecord({ rawTitle: 'Opus One 2018' });
    const candidate = extract(record);
    expect(Array.isArray(candidate.noiseFlags)).toBe(true);
  });
});
