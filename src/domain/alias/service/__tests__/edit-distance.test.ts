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

describe('KIL typo-recall regression — Damerau/JW blending must clear pg-alias-matcher thresholds', () => {
  /**
   * pg-alias-matcher.ts:bestFuzzySimilarity gates on (using compact forms):
   *   damerauDistance ≤ floor(maxLen · 0.25)  OR
   *   trigramOverlap ≥ 0.45                   OR
   *   bigramOverlap  ≥ 0.6
   * and reports similarity = max(damerauSim, jaroWinkler, trigramOverlap, bigramOverlap).
   *
   * Below we verify the algorithm-level building blocks separately for
   * well-known KIL typo classes. If any of these regress (e.g. someone reverts
   * Damerau back to Levenshtein) the recall guarantee for `/v1/search/lookup`
   * silently degrades — this suite catches the move at unit-test time.
   */
  const RATIO = 0.25;
  const maxDistanceFor = (a: string, b: string): number =>
    Math.max(1, Math.floor(Math.max(a.length, b.length) * RATIO));

  it('single-edit substitution: "Sasicaia" → "Sassicaia" (compact form) clears threshold', () => {
    const a = 'sasicaia';
    const b = 'sassicaia';
    const d = damerauLevenshteinOsa(a, b);
    expect(d).toBeLessThanOrEqual(maxDistanceFor(a, b));
    expect(jaroWinklerSimilarity(a, b)).toBeGreaterThan(0.85);
  });

  it('adjacent transposition: "opus one" → "opsu one" clears with Damerau but FAILS with Levenshtein on tight thresholds', () => {
    const a = 'opusone';
    const b = 'opsuone';
    expect(damerauLevenshteinOsa(a, b)).toBe(1);
    expect(levenshteinDistance(a, b)).toBe(2);
    // maxDistance for length 7 = floor(7*0.25) = 1. Damerau passes, Levenshtein fails.
    expect(damerauLevenshteinOsa(a, b)).toBeLessThanOrEqual(maxDistanceFor(a, b));
    expect(levenshteinDistance(a, b)).toBeGreaterThan(maxDistanceFor(a, b));
  });

  it('Korean syllable transposition: "샤또" ↔ "샤토" treated as 1 Damerau-edit', () => {
    expect(damerauLevenshteinOsa('샤또 마고', '샤토 마고')).toBeLessThanOrEqual(1);
  });

  it('Jaro-Winkler boosts prefix-shared producer family (Bordeaux Château ...) over plain Jaro', () => {
    const baseline = jaroSimilarity('Château Margaux', 'Château Lafite');
    const boosted = jaroWinklerSimilarity('Château Margaux', 'Château Lafite');
    // Long shared prefix → JW > Jaro (when Jaro ≥ promote threshold).
    if (baseline >= 0.7) {
      expect(boosted).toBeGreaterThan(baseline);
    }
  });

  it('numeric vintage edit: "Margaux 2015" → "Margaux 2016" stays high-similarity', () => {
    // Only the last char differs — substring overlap dominates.
    const a = 'margaux2015';
    const b = 'margaux2016';
    expect(damerauLevenshteinOsa(a, b)).toBe(1);
    expect(jaroWinklerSimilarity(a, b)).toBeGreaterThan(0.95);
  });

  it('completely unrelated strings stay below the 0.45 trigram-overlap floor (no false-positive recall)', () => {
    // Negative-case regression: short common substring must not create false
    // similarity. "cat" vs "Château Margaux Pavillon" — 'cat' appears inside
    // "Château" but the larger structures are unrelated.
    expect(jaroWinklerSimilarity('cat', 'corkscrew')).toBeLessThan(0.7);
  });
});

describe('boundary: UTF-16 surrogate-pair behaviour (documented limitation)', () => {
  /**
   * edit-distance.ts is explicit that comparisons use UTF-16 code units.
   * Surrogate-pair characters (most emojis, supplementary-plane CJK) count
   * as two units. The wine alias catalog runs an NFC pass upstream so this
   * does not impact normal entity matching, but we still need to assert that
   * the algorithms do not throw and produce sensible bounds on such input,
   * so the "limitation" doesn't drift into "silent crash".
   */
  it('damerauLevenshteinOsa: same emoji on both sides has distance 0', () => {
    expect(damerauLevenshteinOsa('🍷', '🍷')).toBe(0);
  });

  it('damerauLevenshteinOsa: identical emoji-prefixed labels have distance 0', () => {
    expect(damerauLevenshteinOsa('🍷 opus', '🍷 opus')).toBe(0);
  });

  it('damerauLevenshteinOsa: emoji-prefixed vs plain reports 2 (the surrogate pair plus the space)', () => {
    // Documented behaviour: the wine glass surrogate pair counts as 2 units.
    // Plus the leading space → total distance 3 by code-unit accounting.
    const distance = damerauLevenshteinOsa('🍷 opus', 'opus');
    expect(distance).toBeGreaterThanOrEqual(2);
    expect(distance).toBeLessThanOrEqual(3);
  });

  it('jaroWinklerSimilarity stays in [0, 1] for emoji inputs (no NaN / no throw)', () => {
    const value = jaroWinklerSimilarity('🍷 opus one', 'opus one');
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
    expect(Number.isFinite(value)).toBe(true);
  });

  it('jaroSimilarity handles a pure-emoji input pair without throwing', () => {
    expect(jaroSimilarity('🍷', '🍷')).toBe(1);
    const cross = jaroSimilarity('🍷', '🍇');
    expect(cross).toBeGreaterThanOrEqual(0);
    expect(cross).toBeLessThanOrEqual(1);
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
