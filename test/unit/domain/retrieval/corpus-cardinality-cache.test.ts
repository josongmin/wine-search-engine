import { describe, it, expect } from 'vitest';
import { InMemoryCorpusCardinalityCache, CORPUS_LIMITED_THRESHOLD } from '../../../../src/domain/retrieval/service/corpus-cardinality-cache.js';

describe('InMemoryCorpusCardinalityCache', () => {
  const cache = new InMemoryCorpusCardinalityCache(
    new Map([['red', 7000], ['white', 100], ['sparkling', 60]]),
  );

  it('getTypeCount returns count for known type', () => {
    expect(cache.getTypeCount('red')).toBe(7000);
    expect(cache.getTypeCount('white')).toBe(100);
  });

  it('getTypeCount returns undefined for unknown type', () => {
    expect(cache.getTypeCount('orange')).toBeUndefined();
  });

  it('getTotalCount sums all types', () => {
    expect(cache.getTotalCount()).toBe(7160);
  });

  it('isCorpusLimited returns true for small type', () => {
    expect(cache.isCorpusLimited('white')).toBe(true);
    expect(cache.isCorpusLimited('sparkling')).toBe(true);
  });

  it('isCorpusLimited returns false for large type', () => {
    expect(cache.isCorpusLimited('red')).toBe(false);
  });

  it('isCorpusLimited with undefined checks total corpus', () => {
    expect(cache.isCorpusLimited(undefined)).toBe(false);
    const tiny = new InMemoryCorpusCardinalityCache(new Map([['red', 50]]));
    expect(tiny.isCorpusLimited(undefined)).toBe(true);
  });

  it('empty cache isCorpusLimited returns true for everything', () => {
    const empty = InMemoryCorpusCardinalityCache.empty();
    expect(empty.isCorpusLimited('red')).toBe(true);
    expect(empty.isCorpusLimited(undefined)).toBe(true);
    expect(empty.getTotalCount()).toBe(0);
  });

  it('threshold constant is reasonable', () => {
    expect(CORPUS_LIMITED_THRESHOLD).toBeGreaterThanOrEqual(50);
    expect(CORPUS_LIMITED_THRESHOLD).toBeLessThanOrEqual(1000);
  });
});
