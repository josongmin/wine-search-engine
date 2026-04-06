import { describe, it, expect } from 'vitest';
import { detectDecomposition } from '../decomposition-detector.js';

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
    }
  });

  it('single entity query → not decomposed', () => {
    const result = detectDecomposition('Chateau Lafite Rothschild 2015');
    expect(result.decomposed).toBe(false);
  });
});
