import { describe, it, expect } from 'vitest';
import { RelativeQueryExtractor } from '../relative-query-extractor.js';

describe('RelativeQueryExtractor', () => {
  const extractor = new RelativeQueryExtractor();

  // ── 1. Korean similarity: 같은 ─────────────────────────────────────────────

  it('1. "오퍼스 원 같은 와인" → similar_to, anchorSurfaceForm: "오퍼스 원"', () => {
    const result = extractor.extract('오퍼스 원 같은 와인');
    expect(result).not.toBeNull();
    expect(result?.relativeExpressions[0]?.operator).toBe('similar_to');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('오퍼스 원');
  });

  // ── 2. English anchor + Korean marker ─────────────────────────────────────

  it('2. "Opus One 같은" → similar_to, anchorSurfaceForm: "Opus One"', () => {
    const result = extractor.extract('Opus One 같은');
    expect(result).not.toBeNull();
    expect(result?.relativeExpressions[0]?.operator).toBe('similar_to');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('Opus One');
  });

  // ── 3. cheaper_than with impliedAxis ──────────────────────────────────────

  it('3. "샤토 마고보다 저렴한" → cheaper_than, impliedAxis: price_band', () => {
    const result = extractor.extract('샤토 마고보다 저렴한');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    expect(expr?.operator).toBe('cheaper_than');
    expect(expr?.impliedAxis).toBe('price_band');
    expect(expr?.anchorSurfaceForm).toBe('샤토 마고');
  });

  // ── 4. English cheaper_than ───────────────────────────────────────────────

  it('4. "cheaper than Chateau Margaux" → cheaper_than', () => {
    const result = extractor.extract('cheaper than Chateau Margaux');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    expect(expr?.operator).toBe('cheaper_than');
    expect(expr?.anchorSurfaceForm).toBe('Chateau Margaux');
  });

  // ── 5. not operator (말고) ────────────────────────────────────────────────

  it('5. "오퍼스 원 말고" → not operator', () => {
    const result = extractor.extract('오퍼스 원 말고');
    expect(result).not.toBeNull();
    expect(result?.relativeExpressions[0]?.operator).toBe('not');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('오퍼스 원');
  });

  // ── 6. fuller_than with impliedAxis ───────────────────────────────────────

  it('6. "Barolo보다 묵직한" → fuller_than, impliedAxis: body', () => {
    const result = extractor.extract('Barolo보다 묵직한');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    expect(expr?.operator).toBe('fuller_than');
    expect(expr?.impliedAxis).toBe('body');
    expect(expr?.anchorSurfaceForm).toBe('Barolo');
  });

  // ── 7. No relative expression → null ─────────────────────────────────────

  it('7. "보르도 와인" → null (no relative expression)', () => {
    const result = extractor.extract('보르도 와인');
    expect(result).toBeNull();
  });

  // ── 8. English "similar to" ───────────────────────────────────────────────

  it('8. "similar to Opus One" → similar_to, anchorSurfaceForm: "Opus One"', () => {
    const result = extractor.extract('similar to Opus One');
    expect(result).not.toBeNull();
    const expr = result?.relativeExpressions[0];
    expect(expr?.operator).toBe('similar_to');
    expect(expr?.anchorSurfaceForm).toBe('Opus One');
  });

  // ── 9. isSimilarityQuery flag ─────────────────────────────────────────────

  it('9a. isSimilarityQuery: true for similar_to', () => {
    const result = extractor.extract('오퍼스 원 같은');
    expect(result?.isSimilarityQuery).toBe(true);
  });

  it('9b. isSimilarityQuery: false for cheaper_than', () => {
    const result = extractor.extract('cheaper than Chateau Margaux');
    expect(result?.isSimilarityQuery).toBe(false);
  });

  // ── 10. confidence in [0, 1] ──────────────────────────────────────────────

  it('10. confidence field is in [0, 1]', () => {
    const cases = [
      '오퍼스 원 같은',
      'cheaper than Chateau Margaux',
      'Barolo보다 묵직한',
      'similar to Opus One',
    ];
    for (const query of cases) {
      const result = extractor.extract(query);
      expect(result).not.toBeNull();
      for (const expr of result?.relativeExpressions ?? []) {
        expect(expr.confidence).toBeGreaterThanOrEqual(0);
        expect(expr.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  // ── Additional coverage ───────────────────────────────────────────────────

  it('"less expensive than Opus One" → cheaper_than', () => {
    const result = extractor.extract('less expensive than Opus One');
    expect(result?.relativeExpressions[0]?.operator).toBe('cheaper_than');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('Opus One');
  });

  it('"lighter than Pinot Noir" → lighter_than, impliedAxis: body', () => {
    const result = extractor.extract('lighter than Pinot Noir');
    expect(result?.relativeExpressions[0]?.operator).toBe('lighter_than');
    expect(result?.relativeExpressions[0]?.impliedAxis).toBe('body');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('Pinot Noir');
  });

  it('"sweeter than Chablis" → sweeter_than, impliedAxis: sweetness', () => {
    const result = extractor.extract('sweeter than Chablis');
    expect(result?.relativeExpressions[0]?.operator).toBe('sweeter_than');
    expect(result?.relativeExpressions[0]?.impliedAxis).toBe('sweetness');
  });

  it('"drier than Riesling" → drier_than, impliedAxis: sweetness', () => {
    const result = extractor.extract('drier than Riesling');
    expect(result?.relativeExpressions[0]?.operator).toBe('drier_than');
    expect(result?.relativeExpressions[0]?.impliedAxis).toBe('sweetness');
  });

  it('"better than Screaming Eagle" → better_than', () => {
    const result = extractor.extract('better than Screaming Eagle');
    expect(result?.relativeExpressions[0]?.operator).toBe('better_than');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('Screaming Eagle');
  });

  it('"instead of Opus One" → not operator', () => {
    const result = extractor.extract('instead of Opus One');
    expect(result?.relativeExpressions[0]?.operator).toBe('not');
  });

  it('"오퍼스 원 대신" → not operator', () => {
    const result = extractor.extract('오퍼스 원 대신');
    expect(result?.relativeExpressions[0]?.operator).toBe('not');
    expect(result?.relativeExpressions[0]?.anchorSurfaceForm).toBe('오퍼스 원');
  });
});
