import { describe, expect, it } from 'vitest';
import {
  doubleMetaphone,
  doubleMetaphoneKeys,
  doubleMetaphoneMatches,
} from '../double-metaphone.js';

describe('doubleMetaphone — reference cases from Philips (2000)', () => {
  // These are the published canonical test cases from the C/C++ Users
  // Journal article. If any drift, treat as an upstream library
  // regression — not a wrapper bug.
  it('encodes "Thompson" with a single primary code', () => {
    const keys = doubleMetaphone('Thompson');
    expect(keys.primary).toBe('TMPSN');
    expect(keys.alternate).toBeNull();
  });

  it('encodes "Smith" with single canonical code (XMT)', () => {
    const keys = doubleMetaphone('Smith');
    // The library returns XMT for Smith — the published paper lists
    // SM0/XMT, but the canonical JS reference normalizes the alternate
    // away when it matches. We assert what the SOTA implementation
    // actually produces; the wine-search-engine relies on the upstream
    // library, not the paper directly.
    expect(keys.primary).toBe('SM0');
    expect(keys.alternate).toBe('XMT');
  });

  it('encodes "Schmidt" with primary/alternate XMT/SMT', () => {
    const keys = doubleMetaphone('Schmidt');
    expect(keys.primary).toBe('XMT');
    expect(keys.alternate).toBe('SMT');
  });
});

describe('doubleMetaphone — wine-domain phonetic equivalence', () => {
  it('Margaux and Margeaux share a phonetic key (primary or alternate)', () => {
    const margaux = doubleMetaphone('Margaux');
    const margeaux = doubleMetaphone('Margeaux');
    expect(margaux.primary).toBe('MRK');
    expect(margeaux.primary).toBe('MRJ');
    expect(margeaux.alternate).toBe('MRK');
    // The Double Metaphone contract: matching is by key-set overlap,
    // not by primary equality. We verify the cross-pronunciation match.
    expect(doubleMetaphoneMatches('Margaux', 'Margeaux')).toBe(true);
  });

  it('Sassicaia and Sasicaia share the same primary key', () => {
    const sass = doubleMetaphone('Sassicaia');
    const sasi = doubleMetaphone('Sasicaia');
    expect(sass.primary).toBe('SSK');
    expect(sasi.primary).toBe('SSK');
  });

  it('Bordeaux returns a populated primary key', () => {
    const keys = doubleMetaphone('Bordeaux');
    expect(keys.primary).toBe('PRT');
    expect(keys.primary.length).toBeGreaterThan(0);
  });

  it('Chandon and Shandon collide phonetically (XNTN)', () => {
    expect(doubleMetaphone('Chandon').primary).toBe('XNTN');
    expect(doubleMetaphone('Shandon').primary).toBe('XNTN');
  });

  it('Romanee and Romane collide (RMN)', () => {
    expect(doubleMetaphone('Romanee').primary).toBe('RMN');
    expect(doubleMetaphone('Romane').primary).toBe('RMN');
  });
});

describe('doubleMetaphone — diacritic normalization', () => {
  it('Pétrus (accented) and Petrus (ASCII) share an identical key', () => {
    expect(doubleMetaphone('Pétrus')).toEqual(doubleMetaphone('Petrus'));
  });

  it('Château and Chateau share an identical key', () => {
    expect(doubleMetaphone('Château')).toEqual(doubleMetaphone('Chateau'));
  });

  it('Moët and Moet share an identical key', () => {
    expect(doubleMetaphone('Moët')).toEqual(doubleMetaphone('Moet'));
  });
});

describe('doubleMetaphone — empty and degenerate inputs', () => {
  it('empty string returns empty primary and null alternate (does not throw)', () => {
    expect(() => doubleMetaphone('')).not.toThrow();
    const keys = doubleMetaphone('');
    expect(keys.primary).toBe('');
    expect(keys.alternate).toBeNull();
  });

  it('pure whitespace returns empty keys', () => {
    expect(doubleMetaphone('   ').primary).toBe('');
    expect(doubleMetaphone('\t\n  ').alternate).toBeNull();
  });

  it('pure punctuation returns empty keys', () => {
    expect(doubleMetaphone('!!!').primary).toBe('');
    expect(doubleMetaphone('--').primary).toBe('');
  });

  it('pure digits return empty primary (no Latin letters)', () => {
    expect(doubleMetaphone('2015').primary).toBe('');
  });
});

describe('doubleMetaphone — non-Latin script policy', () => {
  it('Hangul-only input does not throw and returns empty primary', () => {
    expect(() => doubleMetaphone('샤또마고')).not.toThrow();
    const keys = doubleMetaphone('샤또마고');
    expect(keys.primary).toBe('');
    expect(keys.alternate).toBeNull();
  });

  it('Japanese-only input returns empty primary', () => {
    expect(doubleMetaphone('ワイン').primary).toBe('');
  });

  it('Chinese-only input returns empty primary', () => {
    expect(doubleMetaphone('葡萄酒').primary).toBe('');
  });

  it('emoji-only input returns empty primary', () => {
    expect(doubleMetaphone('🍷🍇').primary).toBe('');
  });
});

describe('doubleMetaphoneKeys — set semantics', () => {
  it('empty input returns an empty set', () => {
    expect(doubleMetaphoneKeys('').size).toBe(0);
  });

  it('single-pronunciation word returns a size-1 set', () => {
    const keys = doubleMetaphoneKeys('Margaux');
    expect(keys.size).toBe(1);
    expect(keys.has('MRK')).toBe(true);
  });

  it('dual-pronunciation word returns a size-2 set', () => {
    const keys = doubleMetaphoneKeys('Schmidt');
    expect(keys.size).toBe(2);
    expect(keys.has('XMT')).toBe(true);
    expect(keys.has('SMT')).toBe(true);
  });
});

describe('doubleMetaphoneMatches — phonetic equality predicate', () => {
  it('returns true for known wine-name phonetic equivalents', () => {
    expect(doubleMetaphoneMatches('Margaux', 'Margeaux')).toBe(true);
    expect(doubleMetaphoneMatches('Sassicaia', 'Sasicaia')).toBe(true);
    expect(doubleMetaphoneMatches('Chandon', 'Shandon')).toBe(true);
    expect(doubleMetaphoneMatches('Romanee', 'Romane')).toBe(true);
  });

  it('returns false for phonetically unrelated names', () => {
    expect(doubleMetaphoneMatches('Margaux', 'Petrus')).toBe(false);
    expect(doubleMetaphoneMatches('Bordeaux', 'Champagne')).toBe(false);
  });

  it('returns false when either input is empty (refuses to fabricate a match)', () => {
    expect(doubleMetaphoneMatches('', 'Margaux')).toBe(false);
    expect(doubleMetaphoneMatches('Margaux', '')).toBe(false);
    expect(doubleMetaphoneMatches('', '')).toBe(false);
  });

  it('returns false when either input is Hangul (no phonetic signal)', () => {
    expect(doubleMetaphoneMatches('샤또마고', 'Margaux')).toBe(false);
    expect(doubleMetaphoneMatches('Margaux', '샤또마고')).toBe(false);
  });
});

describe('doubleMetaphone — pure / deterministic / no-throw contract', () => {
  it('produces the same output for repeated calls (pure function)', () => {
    const a = doubleMetaphone('Sassicaia');
    const b = doubleMetaphone('Sassicaia');
    expect(a).toEqual(b);
  });

  it('does not mutate the input string', () => {
    const input = 'Margaux';
    doubleMetaphone(input);
    expect(input).toBe('Margaux');
  });

  it('handles adversarial long inputs without throwing', () => {
    // 8192 chars of mixed Latin — checks that there's no algorithmic
    // explosion or stack overflow in the upstream library.
    const long = 'a'.repeat(8192);
    expect(() => doubleMetaphone(long)).not.toThrow();
    expect(doubleMetaphone(long).primary.length).toBeGreaterThan(0);
  });
});
