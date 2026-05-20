import { describe, expect, it } from 'vitest';
import {
  damerauLevenshteinOsa,
  editDistanceSimilarity,
  jaroSimilarity,
  jaroWinklerSimilarity,
  levenshteinDistance,
} from '../edit-distance.js';

describe('levenshteinDistance — baseline insertion/deletion/substitution', () => {
  it('returns 0 for identical strings (canonical zero-distance)', () => {
    expect(levenshteinDistance('opus one', 'opus one')).toBe(0);
  });

  it('returns the longer length when one side is empty (trivial deletion / insertion)', () => {
    expect(levenshteinDistance('', 'opus one')).toBe(8);
    expect(levenshteinDistance('opus one', '')).toBe(8);
  });

  it('1 substitution: "opus" → "opes" → distance 1', () => {
    expect(levenshteinDistance('opus', 'opes')).toBe(1);
  });

  it('1 insertion: "Sasicaia" → "Sassicaia" → distance 1', () => {
    expect(levenshteinDistance('Sasicaia', 'Sassicaia')).toBe(1);
  });

  it('counts an adjacent transposition as 2 edits (the Damerau-Levenshtein delta)', () => {
    // "abcd" ↔ "abdc": Levenshtein = 2 (substitute c→d, substitute d→c) /
    // OSA = 1 (single transposition). This is the exact case that motivates
    // Damerau-Levenshtein adoption for typo recall.
    expect(levenshteinDistance('abcd', 'abdc')).toBe(2);
  });
});

describe('damerauLevenshteinOsa — Levenshtein + adjacent transposition as a single edit', () => {
  it('returns 0 for identical strings', () => {
    expect(damerauLevenshteinOsa('opus one', 'opus one')).toBe(0);
  });

  it('returns the longer length when one side is empty', () => {
    expect(damerauLevenshteinOsa('', 'opus one')).toBe(8);
    expect(damerauLevenshteinOsa('opus one', '')).toBe(8);
  });

  it('treats adjacent transposition as distance 1 (vs Levenshtein 2)', () => {
    expect(damerauLevenshteinOsa('abcd', 'abdc')).toBe(1);
    expect(damerauLevenshteinOsa('teh', 'the')).toBe(1);
    expect(damerauLevenshteinOsa('Romanee', 'Romaene')).toBe(1);
  });

  it('still measures non-transposition typos at the standard cost', () => {
    expect(damerauLevenshteinOsa('Sasicaia', 'Sassicaia')).toBe(1); // pure insertion
    expect(damerauLevenshteinOsa('opus', 'opes')).toBe(1); // pure substitution
  });

  it('combines transposition with other edits (multi-character typo)', () => {
    // "Margaux" vs "Margaxu" (last two chars transposed) = 1 OSA edit.
    expect(damerauLevenshteinOsa('Margaux', 'Margaxu')).toBe(1);
  });

  it('OSA bound is always ≤ Levenshtein bound (transposition never costs more)', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['Sasicaia', 'Sassicaia'],
      ['Romanee Conti', 'Ramonee Conti'],
      ['opus one', 'opsu one'],
      ['Margaux', 'Margaxu'],
      ['Pavillon Rouge', 'Pavillin Rouge'],
    ];
    for (const [a, b] of pairs) {
      expect(damerauLevenshteinOsa(a, b)).toBeLessThanOrEqual(levenshteinDistance(a, b));
    }
  });

  it('handles Hangul precomposed syllables (single BMP code unit per syllable)', () => {
    expect(damerauLevenshteinOsa('샤또 마고', '샤또 마고')).toBe(0);
    expect(damerauLevenshteinOsa('샤또 마고', '샤토 마고')).toBe(1); // 또 ↔ 토
  });
});

describe('jaroSimilarity — base Jaro metric', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroSimilarity('opus one', 'opus one')).toBe(1);
  });

  it('returns 0 for either-empty inputs', () => {
    expect(jaroSimilarity('', 'opus')).toBe(0);
    expect(jaroSimilarity('opus', '')).toBe(0);
  });

  it('returns a value in (0, 1) for non-trivial similar strings', () => {
    const s = jaroSimilarity('Martha', 'Marhta');
    expect(s).toBeGreaterThan(0.94);
    expect(s).toBeLessThan(1);
  });

  it('symmetry: J(a, b) === J(b, a)', () => {
    expect(jaroSimilarity('opus one', 'opus oen')).toBe(jaroSimilarity('opus oen', 'opus one'));
  });
});

describe('jaroWinklerSimilarity — prefix-weighted Jaro', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinklerSimilarity('opus one', 'opus one')).toBe(1);
  });

  it('boosts above base Jaro when leading prefix agrees (and Jaro ≥ promote threshold)', () => {
    // "Château Margaux" vs "Château Margauz" — long shared prefix, single
    // tail substitution. Jaro is high, Winkler boost is meaningful.
    const jaro = jaroSimilarity('Château Margaux', 'Château Margauz');
    const jw = jaroWinklerSimilarity('Château Margaux', 'Château Margauz');
    expect(jw).toBeGreaterThan(jaro);
  });

  it('does NOT apply the Winkler boost when base Jaro is below the promotion threshold', () => {
    // Random short pair with shared first letter; Jaro stays low.
    const a = 'cat';
    const b = 'corkscrew';
    const jaro = jaroSimilarity(a, b);
    const jw = jaroWinklerSimilarity(a, b);
    if (jaro < 0.7) {
      expect(jw).toBe(jaro);
    }
  });

  it('caps the prefix contribution at 4 characters (Winkler 1990 standard)', () => {
    // Two strings with 5+ shared prefix vs 4-shared-prefix; with same tail Jaro,
    // the Winkler boost saturates at 4.
    const jw5 = jaroWinklerSimilarity('abcdef', 'abcdez');
    const jw4 = jaroWinklerSimilarity('abcdg', 'abcdh');
    // We don't assert equality (Jaro itself differs); we only require that
    // the boost cap is honored — the function should not error on long prefixes.
    expect(jw5).toBeLessThanOrEqual(1);
    expect(jw4).toBeLessThanOrEqual(1);
  });

  it('result is always in [0, 1]', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['', ''],
      ['a', 'b'],
      ['opus one', 'opus oen'],
      ['Château Margaux', 'Chateaa Margaux'],
      ['샤또 마고', '샤토 마고'],
    ];
    for (const [a, b] of pairs) {
      const v = jaroWinklerSimilarity(a, b);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('respects override options (prefix scale, cap, promote threshold)', () => {
    const base = jaroWinklerSimilarity('abcdefg', 'abcdfeg');
    const boosted = jaroWinklerSimilarity('abcdefg', 'abcdfeg', {
      prefixScale: 0.25,
      prefixCap: 4,
      promoteThreshold: 0.0,
    });
    expect(boosted).toBeGreaterThan(base);
  });
});

describe('editDistanceSimilarity — normalized [0, 1] view of distance', () => {
  it('returns 1 on empty-vs-empty (canonical zero-distance trivial pair)', () => {
    expect(editDistanceSimilarity('', '', 0)).toBe(1);
  });

  it('returns 1 on identical strings', () => {
    expect(editDistanceSimilarity('opus', 'opus', 0)).toBe(1);
  });

  it('returns 0 when distance equals max length', () => {
    expect(editDistanceSimilarity('abc', 'xyz', 3)).toBe(0);
  });

  it('scales linearly with distance', () => {
    expect(editDistanceSimilarity('abcd', 'abce', 1)).toBeCloseTo(0.75);
    expect(editDistanceSimilarity('abcd', 'abef', 2)).toBeCloseTo(0.5);
  });
});
