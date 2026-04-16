import { describe, it, expect } from 'vitest';
import { InMemoryCorpusCardinalityCache, CORPUS_LIMITED_THRESHOLD } from '../../src/domain/retrieval/service/corpus-cardinality-cache.js';

describe('corpus_limited prevents futile retry (latency regression guard)', () => {
  it('sparkling with 60 entities is corpus_limited', () => {
    const cache = new InMemoryCorpusCardinalityCache(
      new Map([['red', 7000], ['sparkling', 60]]),
    );
    expect(cache.isCorpusLimited('sparkling')).toBe(true);
  });

  it('red with 7000 entities is NOT corpus_limited', () => {
    const cache = new InMemoryCorpusCardinalityCache(
      new Map([['red', 7000], ['sparkling', 60]]),
    );
    expect(cache.isCorpusLimited('red')).toBe(false);
  });

  it('threshold constant matches domain expectation for diversity indexing', () => {
    // 200 threshold: any type with < 200 entities should not trigger retries.
    // This was set based on the 2026-04-16 diversity indexing incident where
    // 60 sparkling / 100 white caused 7/20 unreliable retries → 2x latency.
    expect(CORPUS_LIMITED_THRESHOLD).toBe(200);
  });
});
