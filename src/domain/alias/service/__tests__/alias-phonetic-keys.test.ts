import { describe, expect, it } from 'vitest';
import { computeAliasPhoneticKeys } from '../alias-phonetic-keys.js';
import { doubleMetaphoneKeys } from '../double-metaphone.js';

describe('computeAliasPhoneticKeys', () => {
  it('returns sorted distinct Double Metaphone keys for Latin alias surfaces', () => {
    const keys = computeAliasPhoneticKeys('margaux');
    expect(keys).toEqual([...doubleMetaphoneKeys('margaux')].sort((left, right) =>
      left.localeCompare(right),
    ));
    expect(keys.length).toBeGreaterThan(0);
  });

  it('returns an empty array for blank normalized surfaces', () => {
    expect(computeAliasPhoneticKeys('   ')).toEqual([]);
  });

  it('returns an empty array for Hangul-only surfaces (DM is Latin-only)', () => {
    expect(computeAliasPhoneticKeys('오푸스원')).toEqual([]);
  });
});
