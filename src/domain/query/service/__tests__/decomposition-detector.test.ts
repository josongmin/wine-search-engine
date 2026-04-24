import { describe, it, expect } from 'vitest';
import { analyzeQueryDecomposition, detectDecomposition } from '../decomposition-detector.js';

describe('detectDecomposition', () => {
  it('"Opus One vs Screaming Eagle" → decomposed', () => {
    const result = detectDecomposition('Opus One vs Screaming Eagle');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries[0]).toBe('Opus One');
      expect(result.subQueries[1]).toBe('Screaming Eagle');
    }
  });

  it('"Opus One versus Screaming Eagle" → decomposed', () => {
    const result = detectDecomposition('Opus One versus Screaming Eagle');
    expect(result.decomposed).toBe(true);
  });

  it('"red wine under $20" → not decomposed', () => {
    const result = detectDecomposition('red wine under $20');
    expect(result.decomposed).toBe(false);
  });

  it('"compare Margaux and Pauillac" → decomposed', () => {
    const result = detectDecomposition('compare Margaux and Pauillac');
    expect(result.decomposed).toBe(true);
    if (result.decomposed) {
      expect(result.subQueries[0]).toBe('Margaux');
      expect(result.subQueries[1]).toBe('Pauillac');
      expect(result.comparisonSubtype).toBe('concept');
      expect(result.comparisonLegs[0]).toEqual(expect.objectContaining({
        rawQuery: 'Margaux',
        retrievalQuery: 'Margaux wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        canonicalConcept: 'Margaux',
      }));
      expect(result.comparisonLegs[1]).toEqual(expect.objectContaining({
        rawQuery: 'Pauillac',
        retrievalQuery: 'Pauillac wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        canonicalConcept: 'Pauillac',
      }));
    }
  });

  it('single entity query → not decomposed', () => {
    const result = detectDecomposition('Chateau Lafite Rothschild 2015');
    expect(result.decomposed).toBe(false);
  });

  it('returns a decomposition hint that matches the detected outcome', () => {
    const analysis = analyzeQueryDecomposition('Opus One vs Screaming Eagle');
    expect(analysis.outcome.decomposed).toBe(true);
    expect(analysis.hint.strategy).toBe('comparison');
    expect(analysis.hint.subQueryCount).toBe(2);
    expect(analysis.hint.comparisonSubtype).toBe('concept');
    expect(analysis.hint.comparisonLegs).toEqual([
      expect.objectContaining({
        rawQuery: 'Opus One',
        retrievalQuery: 'Opus One wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        canonicalConcept: 'Opus One',
      }),
      expect.objectContaining({
        rawQuery: 'Screaming Eagle',
        retrievalQuery: 'Screaming Eagle wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'direct_entity_resolution',
        canonicalConcept: 'Screaming Eagle',
      }),
    ]);
  });

  it('uses span-level deterministic concept evidence for concept phrases', () => {
    const analysis = analyzeQueryDecomposition('Napa Cabernet vs Burgundy Pinot Noir');

    expect(analysis.outcome.decomposed).toBe(true);
    if (analysis.outcome.decomposed) {
      expect(analysis.outcome.comparisonSubtype).toBe('concept');
      expect(analysis.outcome.comparisonLegs[0]).toEqual(expect.objectContaining({
        rawQuery: 'Napa Cabernet',
        retrievalQuery: 'Napa Valley Cabernet Sauvignon wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'span_entity_resolution',
        canonicalConcept: 'Napa Valley',
      }));
      expect(analysis.outcome.comparisonLegs[1]).toEqual(expect.objectContaining({
        rawQuery: 'Burgundy Pinot Noir',
        retrievalQuery: 'Burgundy Pinot Noir wine',
        mode: 'concept',
        retrievalMode: 'hybrid',
        evidenceSource: 'span_entity_resolution',
        canonicalConcept: 'Burgundy',
      }));
    }
  });

  it('preserves secondary concept spans in Korean region-grape comparison retrieval queries', () => {
    const analysis = analyzeQueryDecomposition('보르도 카베르네 vs 나파 카베르네');

    expect(analysis.outcome.decomposed).toBe(true);
    if (analysis.outcome.decomposed) {
      expect(analysis.outcome.comparisonLegs[0]).toEqual(expect.objectContaining({
        rawQuery: '보르도 카베르네',
        retrievalQuery: 'Bordeaux Cabernet Sauvignon wine',
        canonicalConcept: 'Bordeaux',
        conceptEntityType: 'region',
      }));
      expect(analysis.outcome.comparisonLegs[1]).toEqual(expect.objectContaining({
        rawQuery: '나파 카베르네',
        retrievalQuery: 'Napa Valley Cabernet Sauvignon wine',
        canonicalConcept: 'Napa Valley',
        conceptEntityType: 'region',
      }));
    }
  });

  it('preserves exact-vintage label comparisons as entity legs instead of concept wine queries', () => {
    const analysis = analyzeQueryDecomposition('Opus One 2018 vs Almaviva 2019');

    expect(analysis.outcome.decomposed).toBe(true);
    if (analysis.outcome.decomposed) {
      expect(analysis.outcome.comparisonSubtype).toBe('entity');
      expect(analysis.outcome.comparisonLegs[0]).toEqual(expect.objectContaining({
        rawQuery: 'Opus One 2018',
        retrievalQuery: 'Opus One 2018',
        mode: 'entity',
        retrievalMode: 'auto',
      }));
      expect(analysis.outcome.comparisonLegs[1]).toEqual(expect.objectContaining({
        rawQuery: 'Almaviva 2019',
        retrievalQuery: 'Almaviva 2019',
        mode: 'entity',
        retrievalMode: 'auto',
      }));
    }
  });
});
