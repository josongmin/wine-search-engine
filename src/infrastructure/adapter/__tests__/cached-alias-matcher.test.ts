import { describe, expect, it, vi } from 'vitest';
import { CachedAliasMatcher } from '../cached-alias-matcher.js';
import type { AliasMatchResult, AliasMatcher } from '../../../domain/query/service/anchor-extractor.js';

function makeMatch(surface: string): AliasMatchResult {
  return {
    surfaceForm: surface,
    normalizedForm: surface.toLowerCase(),
    entityIds: [],
    matchConfidence: 0.9,
  };
}

describe('CachedAliasMatcher', () => {
  it('dedupes repeated single-query lookups with single-flight', async () => {
    const innerFind = vi.fn(async (query: string) => [makeMatch(query)]);
    const inner: AliasMatcher = {
      findMatches: innerFind,
    };
    const matcher = new CachedAliasMatcher(inner, { maxEntries: 128 });

    const [first, second, third] = await Promise.all([
      matcher.findMatches('오푸스원'),
      matcher.findMatches('오푸스원'),
      matcher.findMatches('오푸스원'),
    ]);

    expect(first).toEqual([makeMatch('오푸스원')]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(innerFind).toHaveBeenCalledTimes(1);
  });

  it('reuses batch cache across findMatches and findMatchesBatch', async () => {
    const batchFind = vi.fn(async (queries: readonly string[]) => {
      const map = new Map<string, AliasMatchResult[]>();
      for (const query of queries) {
        map.set(query, query.length > 0 ? [makeMatch(query)] : []);
      }
      return map;
    });
    const inner: AliasMatcher = {
      findMatches: async (query) => [makeMatch(query)],
      findMatchesBatch: batchFind,
    };
    const matcher = new CachedAliasMatcher(inner, { maxEntries: 128 });

    const batchResult = await matcher.findMatchesBatch(['opus one', 'no hit']);
    expect(batchResult.get('opus one')).toEqual([makeMatch('opus one')]);
    expect(batchFind).toHaveBeenCalledTimes(1);

    const singleResult = await matcher.findMatches('opus one');
    expect(singleResult).toEqual([makeMatch('opus one')]);
    expect(batchFind).toHaveBeenCalledTimes(1);
  });

  it('falls back to per-query lookups when batch API is unavailable', async () => {
    const singleFind = vi.fn(async (query: string) => [makeMatch(query)]);
    const inner: AliasMatcher = {
      findMatches: singleFind,
    };

    const matcher = new CachedAliasMatcher(inner, { maxEntries: 128 });
    const result = await matcher.findMatchesBatch(['foo', 'bar']);
    const foo = await matcher.findMatches('foo');

    expect(result.get('foo')).toEqual([makeMatch('foo')]);
    expect(foo).toEqual([makeMatch('foo')]);
    expect(singleFind).toHaveBeenCalledTimes(2);
  });
});
