import { afterEach, describe, expect, it, vi } from 'vitest';
import { FuzzyMatcher } from '../../../domain/query/service/fuzzy-matcher.js';
import { LazyFuzzyMatcher } from '../lazy-fuzzy-matcher.js';

describe('LazyFuzzyMatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds the backing fuzzy index on first match only', () => {
    const initializeSpy = vi.spyOn(FuzzyMatcher.prototype, 'initialize');
    const matcher = new LazyFuzzyMatcher(['chateau margaux', 'opus one']);

    const first = matcher.match('opus one');
    const second = matcher.match('opus one');

    expect(first[0]?.term).toBe('opus one');
    expect(second[0]?.term).toBe('opus one');
    expect(initializeSpy).toHaveBeenCalledTimes(1);
  });

  it('returns no matches when the fuzzy corpus is empty', () => {
    const matcher = new LazyFuzzyMatcher([]);
    expect(matcher.match('opus one')).toEqual([]);
  });
});
