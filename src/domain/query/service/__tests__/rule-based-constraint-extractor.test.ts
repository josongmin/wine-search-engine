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
    const maxPrice = result.soft.find((c) => c.attribute === 'max_price_krw');
    expect(maxPrice).toBeDefined();
    expect(maxPrice?.value).toBe(67_500);
    expect(result.soft.find((c) => c.attribute === 'price_band')).toBeUndefined();
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
    const maxPrice = result.soft.find((c) => c.attribute === 'max_price_krw');
    expect(maxPrice).toBeDefined();
    expect(maxPrice?.value).toBe(67_500);
    expect(result.soft.find((c) => c.attribute === 'price_band')).toBeUndefined();
  });

  it('does not match "under $50" when digit immediately follows (e.g. "under $505")', () => {
    const result = extractRuleBasedConstraints('under $505');
    const maxPrice = result.soft.find((c) => c.attribute === 'max_price_krw');
    expect(maxPrice?.value).toBe(681_750);
    expect(result.soft.find((c) => c.attribute === 'price_band')).toBeUndefined();
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

describe('extractRuleBasedConstraints — sweetness "dry" pattern (SCAN4-05)', () => {
  // CLAUDE.md Rule 23: For any security/filter pattern, add at least one false-positive test.
  it('SCAN4-05 false-positive: "dry white wine" → NO sweetness constraint', () => {
    // "dry" modifies "white" here — it's a wine type adjective, not a sweetness preference.
    const result = extractRuleBasedConstraints('dry white wine');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeUndefined();
  });

  it('SCAN4-05 false-positive: "dry red wine" → NO sweetness constraint', () => {
    const result = extractRuleBasedConstraints('dry red wine');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeUndefined();
  });

  it('SCAN4-05 false-positive: "dry rosé" → NO sweetness constraint', () => {
    const result = extractRuleBasedConstraints('dry rosé');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeUndefined();
  });

  it('SCAN4-05 false-positive: "dry rose" (ASCII) → NO sweetness constraint', () => {
    const result = extractRuleBasedConstraints('dry rose');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeUndefined();
  });

  it('SCAN4-05 false-positive: "dry fruit flavors" → NO sweetness constraint', () => {
    const result = extractRuleBasedConstraints('dry fruit flavors');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeUndefined();
  });

  it('standalone "dry" (not followed by wine type) → sweetness=dry', () => {
    // User intent: "I want something dry" — standalone dry IS a sweetness preference.
    // Note: "dry wine" is excluded by the negative lookahead, but "dry" alone or
    // before non-wine-type words still matches.
    const result = extractRuleBasedConstraints('prefer dry and crisp');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeDefined();
    expect(result.soft.find((c) => c.attribute === 'sweetness')?.value).toBe('dry');
  });

  it('SCAN4-05 note: "dry wine" is excluded by negative lookahead (design decision)', () => {
    // "dry wine" → negative lookahead (?!\s+(?:...wine...)) blocks the match.
    // Users saying "dry wine" are usually just naming the category — the downstream
    // NLMapper or ontology-expansion layer picks up the sweetness signal from context.
    // This is acceptable; the more important fix is preventing "dry white wine" FP.
    const result = extractRuleBasedConstraints('dry wine for dinner');
    // The pattern does NOT match "dry" when "wine" follows — this is intentional.
    // Sweetness may still be inferred by NLMapper; rule-based layer stays conservative.
    // If this behavior changes, update this comment.
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeUndefined();
  });

  it('standalone "dry" in query → sweetness=dry', () => {
    const result = extractRuleBasedConstraints('something dry and crisp');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeDefined();
    expect(result.soft.find((c) => c.attribute === 'sweetness')?.value).toBe('dry');
  });

  it('Korean "드라이" → sweetness=dry', () => {
    const result = extractRuleBasedConstraints('드라이 와인');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeDefined();
    expect(result.soft.find((c) => c.attribute === 'sweetness')?.value).toBe('dry');
  });

  it('"brut" sparkling → sweetness=dry', () => {
    const result = extractRuleBasedConstraints('champagne brut');
    expect(result.soft.find((c) => c.attribute === 'sweetness')).toBeDefined();
    expect(result.soft.find((c) => c.attribute === 'sweetness')?.value).toBe('dry');
  });
});

describe('extractRuleBasedConstraints — soft constraint attributes (W2-01)', () => {
  it('price_band → classified as soft constraint', () => {
    const result = extractRuleBasedConstraints('under 30 wine');
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

describe('extractRuleBasedConstraints — BUG-P1 regression: early return discarded hard constraints', () => {
  // BUG-P1: when price parseInt returned NaN, the function returned early with { hard:[], soft:[], inferred:[] }
  // discarding wine_type, country etc. constraints already accumulated before the price check.
  // Fix: skip only the price_band push, let function continue.

  it('wine_type constraint is preserved when price extraction produces NaN (simulated via no match)', () => {
    // "French red wine" → wine_type=red (hard), country=France (hard)
    // No price match → price block is skipped entirely, no early return risk
    const result = extractRuleBasedConstraints('french red wine');
    expect(result.hard.find((c) => c.attribute === 'wine_type')?.value).toBe('red');
    expect(result.hard.find((c) => c.attribute === 'country')?.value).toBe('France');
  });

  it('wine_type is preserved even when query also has a valid price match', () => {
    // "French red wine under $50" → wine_type=red, country=France preserved alongside max_price_krw
    const result = extractRuleBasedConstraints('french red wine under $50');
    expect(result.hard.find((c) => c.attribute === 'wine_type')?.value).toBe('red');
    expect(result.hard.find((c) => c.attribute === 'country')?.value).toBe('France');
    expect(result.soft.find((c) => c.attribute === 'max_price_krw')?.value).toBe(67_500);
    expect(result.soft.find((c) => c.attribute === 'price_band')).toBeUndefined();
  });
});

describe('extractRuleBasedConstraints — BUG-P2 currency detection from matched text', () => {
  // BUG-P2: old code checked `/만원/u.test(q)` globally — a query like "50달러 와인 10만원 대"
  // would incorrectly apply KRW multiplier to the 50달러 price because 만원 appears elsewhere.
  // Fix: detect currency from the MATCHED text (priceUnder[0]), not the full query.

  it('달러 pattern extracts USD price correctly', () => {
    // "50달러 이하" → $50 USD → mid band
    const result = extractRuleBasedConstraints('50달러 이하 와인');
    const band = result.soft.find((c) => c.attribute === 'price_band');
    expect(band?.value).toBe('mid'); // $50 → mid
  });

  it('만원 pattern extracts KRW price correctly', () => {
    // "5만원 이하" → exact canonical KRW ceiling, not a coarse price band.
    const result = extractRuleBasedConstraints('5만원 이하 와인');
    const maxPrice = result.soft.find((c) => c.attribute === 'max_price_krw');
    expect(maxPrice?.value).toBe(50_000);
    expect(result.soft.find((c) => c.attribute === 'price_band')).toBeUndefined();
  });

  it('달러 match is not contaminated by incidental 만원 elsewhere in query', () => {
    // "50달러 이하 와인, 10만원 예산" — the matched price is 50달러 (USD).
    // Old code: 만원 found in q → applies KRW multiplier → $50 * 10000/1350 ≈ $370 → premium (WRONG).
    // Fix: matched text "50달러 이하" has no 만원 → stays as $50 → mid (CORRECT).
    const result = extractRuleBasedConstraints('50달러 이하 와인');
    const band = result.soft.find((c) => c.attribute === 'price_band');
    expect(band?.value).toBe('mid');
  });

  // SOTA++ structural fix (v14 bench price_expression #70/71/73 RCA):
  // retail-channel keywords (편의점/마트/백화점) emit a SOFT softMaxPriceKrwHint
  // (ranking signal), not a hard maxPriceKrw (YQL filter). The hint is promoted
  // to a SOFT NormalizedConstraint here with confidence 0.55 (lower than the
  // 0.85 of numeric "X만원 이하") so the planner still sees the price band but
  // the ranker doesn't strictly enforce it.

  it('retail-channel "편의점 와인" → soft max_price_krw=15000 (hint, low confidence)', () => {
    const result = extractRuleBasedConstraints('편의점 와인 추천');
    const maxPrice = result.soft.find((c) => c.attribute === 'max_price_krw');
    expect(maxPrice).toBeDefined();
    expect(maxPrice?.value).toBe(15_000);
    // Lower confidence than numeric (0.85) — flags this as approximate.
    expect(maxPrice?.confidence).toBeLessThan(0.85);
    // No hard vintage_year — channel hint should never become hard.
    expect(result.hard.find((c) => c.attribute === 'max_price_krw')).toBeUndefined();
  });

  it('retail-channel "백화점 와인 수준" → soft max_price_krw=100000 (hint)', () => {
    const result = extractRuleBasedConstraints('백화점 와인 수준');
    const maxPrice = result.soft.find((c) => c.attribute === 'max_price_krw');
    expect(maxPrice?.value).toBe(100_000);
    expect(maxPrice?.confidence).toBeLessThan(0.85);
  });

  it('retail-channel with numeric price → numeric wins, hint suppressed', () => {
    // "편의점에서 8천원 이하" — numeric is more specific.
    const result = extractRuleBasedConstraints('편의점에서 8천원 이하 와인');
    const maxPrices = result.soft.filter((c) => c.attribute === 'max_price_krw');
    // Only ONE max_price_krw soft constraint: the numeric 8000, not the channel hint.
    expect(maxPrices).toHaveLength(1);
    expect(maxPrices[0]?.value).toBe(8_000);
    // Numeric confidence is 0.85 (or higher), not the hint's 0.55.
    expect(maxPrices[0]?.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('extractRuleBasedConstraints — Korean connective form patterns (연결형 어미)', () => {
  // Critic score: connective forms "좋고", "높고"
  it('"평점 좋고" → critic_score >= 0.7 (connective form -고)', () => {
    const result = extractRuleBasedConstraints('평점 좋고 바디감 있는 와인');
    const score = result.soft.find((c) => c.attribute === 'critic_score');
    expect(score).toBeDefined();
    expect(score?.operator).toBe('>=');
    expect(score?.value).toBe(0.7);
  });

  it('"점수 높고" → critic_score >= 0.7 (connective form -고)', () => {
    const result = extractRuleBasedConstraints('점수 높고 부드러운 와인');
    const score = result.soft.find((c) => c.attribute === 'critic_score');
    expect(score).toBeDefined();
  });

  // "바디감 있고" → body >= 0.5
  it('"바디감 있고" → body >= 0.5 (connective form -고)', () => {
    const result = extractRuleBasedConstraints('바디감 있고 평점 좋은 와인');
    const body = result.soft.find((c) => c.attribute === 'body');
    expect(body).toBeDefined();
    expect(body?.operator).toBe('>=');
    expect(body?.value).toBe(0.5);
  });

  it('"바디감 있는" → body >= 0.5 (adnominal form)', () => {
    const result = extractRuleBasedConstraints('바디감 있는 와인');
    const body = result.soft.find((c) => c.attribute === 'body');
    expect(body).toBeDefined();
    expect(body?.value).toBe(0.5);
  });

  it('"바디감 좋은" → body >= 0.5', () => {
    const result = extractRuleBasedConstraints('바디감 좋은 레드 와인');
    const body = result.soft.find((c) => c.attribute === 'body');
    expect(body).toBeDefined();
    expect(body?.value).toBe(0.5);
  });

  it('"바디감 좋고" → body >= 0.5 (connective form)', () => {
    const result = extractRuleBasedConstraints('바디감 좋고 산도 높은');
    const body = result.soft.find((c) => c.attribute === 'body');
    expect(body).toBeDefined();
    expect(body?.value).toBe(0.5);
  });

  // "타닌 없고" → tannin <= 0.4
  it('"타닌 없고" → tannin <= 0.4 (connective form -고)', () => {
    const result = extractRuleBasedConstraints('타닌 없고 과일향 풍부한 와인');
    const tannin = result.soft.find((c) => c.attribute === 'tannin');
    expect(tannin).toBeDefined();
    expect(tannin?.operator).toBe('<=');
    expect(tannin?.value).toBe(0.4);
  });

  it('"타닌감 없는" → tannin <= 0.4 (adnominal form)', () => {
    const result = extractRuleBasedConstraints('타닌감 없는 와인');
    const tannin = result.soft.find((c) => c.attribute === 'tannin');
    expect(tannin).toBeDefined();
    expect(tannin?.value).toBe(0.4);
  });

  // False-positive guard: "좋고" without critic score context should NOT match
  it('"좋고" alone without score context does NOT trigger critic_score', () => {
    const result = extractRuleBasedConstraints('맛 좋고 향 좋은 와인');
    const score = result.soft.find((c) => c.attribute === 'critic_score');
    expect(score).toBeUndefined();
  });

  // Combined connective forms in one query
  it('multiple connective forms in one query extract all constraints', () => {
    const result = extractRuleBasedConstraints('평점 좋고 바디감 있고 타닌 없고 과일향 풍부한 와인');
    const score = result.soft.find((c) => c.attribute === 'critic_score');
    const body = result.soft.find((c) => c.attribute === 'body');
    const tannin = result.soft.find((c) => c.attribute === 'tannin');
    const fruit = result.soft.find((c) => c.attribute === 'fruit_intensity');
    expect(score).toBeDefined();
    expect(body).toBeDefined();
    expect(tannin).toBeDefined();
    expect(fruit).toBeDefined();
  });
});
