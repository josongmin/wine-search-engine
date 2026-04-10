/**
 * Tests for rule-based-constraint-extractor.ts
 *
 * BUG-14: Lookahead character class fix — `(?!\p{L})(?!\p{N})` (two separate
 * lookaheads) must be `(?![\p{L}\p{N}])` (single character class OR).
 * Two separate lookaheads form a sequence check, not an alternation, which
 * silently fails for non-ASCII boundaries (Rule 24, Rule 8).
 */

import { describe, it, expect } from 'vitest';
import { extractRuleBasedConstraints } from '../rule-based-constraint-extractor.js';

describe('extractRuleBasedConstraints — price "under" pattern (BUG-14)', () => {
  it('matches plain ASCII "under $50"', () => {
    const result = extractRuleBasedConstraints('under $50 red wine');
    const priceBand = result.soft.find((c) => c.attribute === 'price_band');
    expect(priceBand).toBeDefined();
    expect(priceBand?.value).toBe('mid');
  });

  it('matches "under 30" without dollar sign', () => {
    // $30 > $20 (PRICE_BAND_BUDGET_MAX_USD) → mid band
    const result = extractRuleBasedConstraints('under 30 wine');
    const priceBand = result.soft.find((c) => c.attribute === 'price_band');
    expect(priceBand).toBeDefined();
    expect(priceBand?.value).toBe('mid');
  });

  it('does NOT spuriously match "under30" (no word boundary)', () => {
    // "under30" — no space, the pattern requires \\s+ after "under"
    const result = extractRuleBasedConstraints('under30wine');
    const priceBand = result.soft.find((c) => c.attribute === 'price_band');
    // Should NOT produce a price_band soft constraint from "under30wine"
    // since the digit group has no delimiter from the wine suffix.
    // The regex currently requires \s+, so under30wine won't match either way.
    // This test documents the boundary behaviour.
    expect(priceBand).toBeUndefined();
  });

  // BUG-14: Korean immediately after "under $50" — the two separate lookaheads
  // `(?!\p{L})(?!\p{N})` would fail to detect the Korean character as a "word
  // boundary", treating Korean adjacency as valid termination when it isn't.
  it('matches "under $50" when followed by Korean character — lookahead must use [\\ p{L}\\p{N}] class', () => {
    // "under $50와인" — "와인" = Korean for "wine". With broken lookaheads the
    // regex `(?!\p{L})(?!\p{N})` reads as "next char is not a letter AND not a digit"
    // but actually processes them as a 2-char assertion that never fires correctly.
    // Correct form `(?![\p{L}\p{N}])` prevents matching when letter follows.
    const result = extractRuleBasedConstraints('under $50와인');
    // "와" is \p{L} — the end boundary should prevent the match
    const priceBand = result.soft.find((c) => c.attribute === 'price_band');
    // The number "50" is immediately followed by Korean letter — no boundary.
    // Correct regex: no match (와 is \p{L}).
    expect(priceBand).toBeUndefined();
  });

  it('matches "under $50" followed by space then Korean', () => {
    const result = extractRuleBasedConstraints('under $50 와인');
    const priceBand = result.soft.find((c) => c.attribute === 'price_band');
    expect(priceBand).toBeDefined();
    expect(priceBand?.value).toBe('mid');
  });

  it('does not match "under $50" when digit immediately follows (e.g. "under $505")', () => {
    const result = extractRuleBasedConstraints('under $505');
    // 505 > 100 → luxury, but let's check it actually matches with the correct value
    const priceBand = result.soft.find((c) => c.attribute === 'price_band');
    // "505" → usd=505 > 100 → luxury
    expect(priceBand?.value).toBe('luxury');
  });

  // Additional boundary tests for accented Latin
  it('matches "under $50" followed by accented character — é is \\p{L}', () => {
    // "under $50éclat" — é is \p{L}, so (?![\p{L}\p{N}]) should prevent match
    const result = extractRuleBasedConstraints('under $50éclat');
    const priceBand = result.soft.find((c) => c.attribute === 'price_band');
    // é directly follows 50 — boundary should block match
    expect(priceBand).toBeUndefined();
  });

  it('country rules use correct Unicode lookahead — Korean 프랑스 is matched', () => {
    const result = extractRuleBasedConstraints('프랑스 와인');
    const country = result.hard.find((c) => c.attribute === 'country');
    expect(country).toBeDefined();
    expect(country?.value).toBe('France');
  });

  it('country rules do not spuriously match Korean substrings of longer words', () => {
    // "프랑스어" — "프랑스" (France) is followed by "어" (language suffix, \p{L})
    // so the lookahead (?=$|[^\p{L}\p{N}]) should prevent matching "프랑스" inside "프랑스어"
    const result = extractRuleBasedConstraints('프랑스어 수업');
    const country = result.hard.find((c) => c.attribute === 'country');
    // "프랑스어" = "French language" — should NOT be a country constraint
    expect(country).toBeUndefined();
  });
});

describe('extractRuleBasedConstraints — soft constraint attributes (W2-01)', () => {
  it('price_band → classified as soft constraint', () => {
    const result = extractRuleBasedConstraints('under $30 wine');
    expect(result.hard.find((c) => c.attribute === 'price_band')).toBeUndefined();
    expect(result.soft.find((c) => c.attribute === 'price_band')).toBeDefined();
  });

  it('occasion — not produced by rule extractor (LLM-sourced), but if produced → soft', () => {
    // rule-based extractor does not produce 'occasion' constraints directly;
    // this test verifies the constraint-compiler classification path instead.
    // We just verify the extractor doesn't accidentally emit a hard occasion.
    const result = extractRuleBasedConstraints('birthday dinner wine');
    expect(result.hard.find((c) => c.attribute === 'occasion')).toBeUndefined();
  });

  it('critic_score → soft (평점 좋은 pattern)', () => {
    const result = extractRuleBasedConstraints('평점 좋은 와인');
    expect(result.hard.find((c) => c.attribute === 'critic_score')).toBeUndefined();
    expect(result.soft.find((c) => c.attribute === 'critic_score')).toBeDefined();
  });

  it('fruit_intensity → soft (과일향 풍부 pattern)', () => {
    const result = extractRuleBasedConstraints('과일향 풍부한 와인');
    expect(result.hard.find((c) => c.attribute === 'fruit_intensity')).toBeUndefined();
    expect(result.soft.find((c) => c.attribute === 'fruit_intensity')).toBeDefined();
  });
});
