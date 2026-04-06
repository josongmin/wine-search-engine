import { describe, it, expect, beforeEach } from 'vitest';
import { CharNgramIndex } from '../char-ngram-index.js';

describe('CharNgramIndex', () => {
  let index: CharNgramIndex;

  beforeEach(() => {
    index = new CharNgramIndex();
    index.initialize([
      'Opus One',
      'Romanee-Conti',
      'Moet & Chandon',
      'Chateau Margaux',
      'Penfolds Grange',
      'Dom Perignon',
    ]);
  });

  it('finds "Opus One" from collapsed "opusone"', () => {
    const results = index.search('opusone');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.term).toBe('Opus One');
  });

  it('finds "Romanee-Conti" from collapsed "romaneconti"', () => {
    const results = index.search('romaneconti');
    expect(results.length).toBeGreaterThan(0);
    const terms = results.map((r) => r.term);
    expect(terms).toContain('Romanee-Conti');
  });

  it('finds "Moet & Chandon" from collapsed "moetshandon"', () => {
    // "moetshandon" shares most trigrams with "moet & chandon" after normalization
    const results = index.search('moetschandon');
    expect(results.length).toBeGreaterThan(0);
    const terms = results.map((r) => r.term);
    expect(terms).toContain('Moet & Chandon');
  });

  it('returns empty for short queries (< 3 chars)', () => {
    expect(index.search('ab')).toEqual([]);
    expect(index.search('a')).toEqual([]);
    expect(index.search('')).toEqual([]);
  });

  it('returns empty for unrelated query', () => {
    const results = index.search('sushirestaurant');
    expect(results).toEqual([]);
  });

  it('results are sorted by similarity descending', () => {
    const results = index.search('opusone');
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.similarity).toBeGreaterThanOrEqual(results[i]!.similarity);
    }
  });

  it('respects minSimilarity threshold', () => {
    const looseResults = index.search('opuson', 0.1);
    const strictResults = index.search('opuson', 0.9);
    expect(looseResults.length).toBeGreaterThanOrEqual(strictResults.length);
  });

  it('works on an empty index', () => {
    const emptyIndex = new CharNgramIndex();
    emptyIndex.initialize([]);
    expect(emptyIndex.search('opusone')).toEqual([]);
  });

  it('handles duplicate terms in initialization', () => {
    const idx = new CharNgramIndex();
    idx.initialize(['Opus One', 'Opus One', 'Opus One']);
    const results = idx.search('opusone');
    expect(results.length).toBe(1);
    expect(results[0]!.term).toBe('Opus One');
  });
});
