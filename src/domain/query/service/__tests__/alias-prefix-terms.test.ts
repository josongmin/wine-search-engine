import { describe, expect, it } from 'vitest';
import { buildAliasPrefixTerms, isEligiblePrefixQuery } from '../alias-prefix-terms.js';

describe('alias-prefix-terms', () => {
  it('builds whole-identity surface prefixes plus curated Korean variants', () => {
    const terms = buildAliasPrefixTerms(['Opus One 2018']);

    expect(terms).toEqual(
      expect.arrayContaining([
        'opus one 2018',
        'opus one',
        'opusone2018',
        '오푸스원',
      ]),
    );
    expect(terms).not.toContain('오퍼스원');
    expect(terms).not.toContain('오퍼스 원');
  });

  it('does not emit standalone token prefixes that would widen exact-like evidence', () => {
    const terms = buildAliasPrefixTerms(['Opus One 2018']);

    expect(terms).not.toContain('opus');
    expect(terms).not.toContain('one');
  });

  it('keeps eligibility strict for short prefixes', () => {
    expect(isEligiblePrefixQuery('op')).toBe(false);
    expect(isEligiblePrefixQuery('opu')).toBe(true);
    expect(isEligiblePrefixQuery('오')).toBe(false);
    expect(isEligiblePrefixQuery('오푸')).toBe(true);
  });
});
