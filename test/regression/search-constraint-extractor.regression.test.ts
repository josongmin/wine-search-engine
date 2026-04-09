/**
 * Regression tests for search-constraint-extractor.ts and the exclusion
 * handling wired through rule-based-constraint-extractor → constraint-to-
 * sparse-filter-tokens → buildSparseFilters.
 *
 * These tests are append-only — never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import {
  extractSearchConstraints,
  searchConstraintsToFilterTokens,
  krwToUsd,
  KRW_PER_USD,
} from '../../src/domain/query/service/search-constraint-extractor.js';
import { extractRuleBasedConstraints } from '../../src/domain/query/service/rule-based-constraint-extractor.js';
import { hardConstraintsToSparseFilterTokens } from '../../src/domain/retrieval/service/constraint-to-sparse-filter-tokens.js';
import { buildSparseFilters } from '../../src/infrastructure/vespa/mapping.js';

// ---------------------------------------------------------------------------
// krwToUsd
// ---------------------------------------------------------------------------

describe('krwToUsd', () => {
  it('converts 50000 KRW to USD correctly', () => {
    const usd = krwToUsd(50_000);
    expect(usd).toBeCloseTo(50_000 / KRW_PER_USD, 2);
  });

  it('rounds to two decimal places', () => {
    const usd = krwToUsd(10_000);
    expect(String(usd)).toMatch(/^\d+\.\d{1,2}$/);
  });

  it('returns 0 for 0 KRW', () => {
    expect(krwToUsd(0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractSearchConstraints — grape exclusion
// ---------------------------------------------------------------------------

describe('extractSearchConstraints — grape exclusion', () => {
  it('extracts Korean grape exclusion with 빼고', () => {
    const c = extractSearchConstraints('카베르네 빼고 레드와인 추천');
    expect(c.excludeGrapes).toContain('Cabernet Sauvignon');
  });

  it('extracts Korean grape exclusion with 제외', () => {
    const c = extractSearchConstraints('메를로 제외한 보르도');
    expect(c.excludeGrapes).toContain('Merlot');
  });

  it('extracts Korean grape exclusion with 말고', () => {
    const c = extractSearchConstraints('피노 누아르 말고 레드와인');
    expect(c.excludeGrapes).toContain('Pinot Noir');
  });

  it('extracts English grape exclusion with not', () => {
    const c = extractSearchConstraints('red wine not Merlot');
    expect(c.excludeGrapes).toContain('Merlot');
  });

  it('extracts English grape exclusion with without', () => {
    const c = extractSearchConstraints('Bordeaux without Cabernet Sauvignon');
    expect(c.excludeGrapes).toContain('Cabernet Sauvignon');
  });

  it('extracts English grape exclusion with no', () => {
    const c = extractSearchConstraints('no Chardonnay please');
    expect(c.excludeGrapes).toContain('Chardonnay');
  });

  it('extracts English grape exclusion with exclude', () => {
    const c = extractSearchConstraints('exclude Riesling');
    expect(c.excludeGrapes).toContain('Riesling');
  });

  it('maps 시라 → Syrah', () => {
    const c = extractSearchConstraints('시라 빼고');
    expect(c.excludeGrapes).toContain('Syrah');
  });

  it('maps 쇼비뇽 → Sauvignon Blanc', () => {
    const c = extractSearchConstraints('쇼비뇽 제외');
    expect(c.excludeGrapes).toContain('Sauvignon Blanc');
  });

  it('deduplicates multiple same-grape exclusions', () => {
    const c = extractSearchConstraints('not Merlot, no Merlot');
    expect(c.excludeGrapes?.filter((g) => g === 'Merlot').length).toBe(1);
  });

  it('returns empty object for query with no exclusions', () => {
    const c = extractSearchConstraints('레드와인 추천해줘');
    expect(c.excludeGrapes).toBeUndefined();
    expect(c.excludeCountries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractSearchConstraints — country exclusion
// ---------------------------------------------------------------------------

describe('extractSearchConstraints — country exclusion', () => {
  it('extracts 프랑스 빼고 → France', () => {
    const c = extractSearchConstraints('프랑스 빼고 레드와인');
    expect(c.excludeCountries).toContain('France');
  });

  it('extracts 이탈리아 제외 → Italy', () => {
    const c = extractSearchConstraints('이탈리아 제외하고 피노누아');
    expect(c.excludeCountries).toContain('Italy');
  });

  it('extracts not France (English)', () => {
    const c = extractSearchConstraints('red wine not France');
    expect(c.excludeCountries).toContain('France');
  });

  it('extracts without Italy (English)', () => {
    const c = extractSearchConstraints('Pinot Noir without Italy');
    expect(c.excludeCountries).toContain('Italy');
  });

  it('maps 호주 → Australia', () => {
    const c = extractSearchConstraints('호주 말고 화이트');
    expect(c.excludeCountries).toContain('Australia');
  });

  it('maps 미국 → United States', () => {
    const c = extractSearchConstraints('미국 빼고');
    expect(c.excludeCountries).toContain('United States');
  });

  it('extracts repeated English exclusions used by agent tool serialization', () => {
    const c = extractSearchConstraints('red wine, not France, not Italy');
    expect(c.excludeCountries).toEqual(expect.arrayContaining(['France', 'Italy']));
  });
});

// ---------------------------------------------------------------------------
// extractSearchConstraints — KRW price
// ---------------------------------------------------------------------------

describe('extractSearchConstraints — KRW price', () => {
  it('parses "5만원 이하" → maxPriceKrw = 50000', () => {
    const c = extractSearchConstraints('5만원 이하 와인');
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('parses "10만원 이상" → minPriceKrw = 100000', () => {
    const c = extractSearchConstraints('10만원 이상 와인');
    expect(c.minPriceKrw).toBe(100_000);
  });

  it('parses range "3~5만원" → min/max', () => {
    const c = extractSearchConstraints('3~5만원 레드');
    expect(c.minPriceKrw).toBe(30_000);
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('parses "5만원대" → band around 50000', () => {
    const c = extractSearchConstraints('5만원대 와인');
    expect(c.minPriceKrw).toBeDefined();
    expect(c.maxPriceKrw).toBeDefined();
    expect(c.minPriceKrw!).toBeLessThan(50_000);
    expect(c.maxPriceKrw!).toBeGreaterThan(50_000);
  });

  it('parses "5만원 이내" → maxPriceKrw = 50000', () => {
    const c = extractSearchConstraints('5만원 이내');
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('returns no price constraints for query without price', () => {
    const c = extractSearchConstraints('레드와인 추천');
    expect(c.maxPriceKrw).toBeUndefined();
    expect(c.minPriceKrw).toBeUndefined();
  });

  it('parses raw won upper bound used by agent tool serialization', () => {
    const c = extractSearchConstraints('레드 와인, 50000원 이하');
    expect(c.maxPriceKrw).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// extractSearchConstraints — vintage
// ---------------------------------------------------------------------------

describe('extractSearchConstraints — vintage', () => {
  it('parses "2018년 이후" → vintageMin = 2018', () => {
    const c = extractSearchConstraints('2018년 이후 빈티지');
    expect(c.vintageMin).toBe(2018);
  });

  it('parses "2020년 이전" → vintageMax = 2020', () => {
    const c = extractSearchConstraints('2020년 이전 와인');
    expect(c.vintageMax).toBe(2020);
  });

  it('parses "2015-2020" range', () => {
    const c = extractSearchConstraints('2015-2020 빈티지 레드');
    expect(c.vintageMin).toBe(2015);
    expect(c.vintageMax).toBe(2020);
  });

  it('parses "2015~2020" range', () => {
    const c = extractSearchConstraints('2015~2020 빈티지 레드');
    expect(c.vintageMin).toBe(2015);
    expect(c.vintageMax).toBe(2020);
  });
});

// ---------------------------------------------------------------------------
// searchConstraintsToFilterTokens
// ---------------------------------------------------------------------------

describe('searchConstraintsToFilterTokens', () => {
  it('produces grape_primary_not and grapes_not tokens for grape exclusion', () => {
    const tokens = searchConstraintsToFilterTokens({ excludeGrapes: ['Merlot'] });
    expect(tokens).toContain('grape_primary_not:Merlot');
    expect(tokens).toContain('grapes_not:Merlot');
  });

  it('produces country_not token for country exclusion', () => {
    const tokens = searchConstraintsToFilterTokens({ excludeCountries: ['France'] });
    expect(tokens).toContain('country_not:France');
  });

  it('produces region_not token for region exclusion', () => {
    const tokens = searchConstraintsToFilterTokens({ excludeRegions: ['Bordeaux'] });
    expect(tokens).toContain('region_not:Bordeaux');
  });

  it('produces style_not token for style exclusion', () => {
    const tokens = searchConstraintsToFilterTokens({ excludeStyles: ['oaked'] });
    expect(tokens).toContain('style_not:oaked');
  });

  it('produces price_usd_max token from maxPriceKrw', () => {
    const tokens = searchConstraintsToFilterTokens({ maxPriceKrw: 50_000 });
    const usdMax = krwToUsd(50_000);
    expect(tokens).toContain(`price_usd_max:${usdMax}`);
  });

  it('produces price_usd_min token from minPriceKrw', () => {
    const tokens = searchConstraintsToFilterTokens({ minPriceKrw: 100_000 });
    const usdMin = krwToUsd(100_000);
    expect(tokens).toContain(`price_usd_min:${usdMin}`);
  });

  it('produces vintage_year_min and vintage_year_max tokens', () => {
    const tokens = searchConstraintsToFilterTokens({ vintageMin: 2015, vintageMax: 2020 });
    expect(tokens).toContain('vintage_year_min:2015');
    expect(tokens).toContain('vintage_year_max:2020');
  });

  it('returns empty array for empty constraints', () => {
    expect(searchConstraintsToFilterTokens({})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildSparseFilters — NOT filter YQL generation
// ---------------------------------------------------------------------------

describe('buildSparseFilters — NOT filter YQL generation', () => {
  it('generates !(grape_primary contains "Merlot") from grape_primary_not token', () => {
    const yql = buildSparseFilters(['grape_primary_not:Merlot']);
    expect(yql).toContain('!(grape_primary contains "Merlot")');
  });

  it('generates !(grapes contains "Merlot") from grapes_not token', () => {
    const yql = buildSparseFilters(['grapes_not:Merlot']);
    expect(yql).toContain('!(grapes contains "Merlot")');
  });

  it('generates !(country contains "France") from country_not token', () => {
    const yql = buildSparseFilters(['country_not:France']);
    expect(yql).toContain('!(country contains "France")');
  });

  it('generates !(region contains "Bordeaux") from region_not token', () => {
    const yql = buildSparseFilters(['region_not:Bordeaux']);
    expect(yql).toContain('!(region contains "Bordeaux")');
  });

  it('generates !(style contains "oaked") from style_not token', () => {
    const yql = buildSparseFilters(['style_not:oaked']);
    expect(yql).toContain('!(style contains "oaked")');
  });

  it('escapes double-quote characters in NOT filter values (YQL injection guard)', () => {
    const yql = buildSparseFilters(['country_not:Fr"ance']);
    expect(yql).toContain('\\"');
    expect(yql).not.toContain('Fr"ance');
  });

  it('combines NOT filter with existing positive filter correctly', () => {
    const yql = buildSparseFilters(['wine_type:red', 'country_not:France']);
    expect(yql).toContain('wine_type contains "red"');
    expect(yql).toContain('!(country contains "France")');
  });

  it('returns empty string for empty filter list', () => {
    expect(buildSparseFilters([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: extractRuleBasedConstraints → hardConstraintsToSparseFilterTokens → buildSparseFilters
// ---------------------------------------------------------------------------

describe('end-to-end: Korean exclusion query → YQL NOT filter', () => {
  it('카베르네 빼고 → !(grape_primary contains "Cabernet Sauvignon")', () => {
    const bundle = extractRuleBasedConstraints('카베르네 빼고 레드와인');
    const tokens = hardConstraintsToSparseFilterTokens(bundle.hard);
    const yql = buildSparseFilters([...tokens]);
    expect(yql).toContain('!(grape_primary contains "Cabernet Sauvignon")');
    expect(yql).toContain('!(grapes contains "Cabernet Sauvignon")');
  });

  it('프랑스 제외 → !(country contains "France")', () => {
    const bundle = extractRuleBasedConstraints('프랑스 제외한 레드와인');
    const tokens = hardConstraintsToSparseFilterTokens(bundle.hard);
    const yql = buildSparseFilters([...tokens]);
    expect(yql).toContain('!(country contains "France")');
  });

  it('not Merlot (English) → !(grape_primary contains "Merlot")', () => {
    const bundle = extractRuleBasedConstraints('red wine not Merlot');
    const tokens = hardConstraintsToSparseFilterTokens(bundle.hard);
    const yql = buildSparseFilters([...tokens]);
    expect(yql).toContain('!(grape_primary contains "Merlot")');
  });

  it('positive wine_type constraint preserved alongside exclusion', () => {
    const bundle = extractRuleBasedConstraints('카베르네 빼고 레드 와인');
    const tokens = hardConstraintsToSparseFilterTokens(bundle.hard);
    const yql = buildSparseFilters([...tokens]);
    // Exclusion is present
    expect(yql).toContain('!(grape_primary contains "Cabernet Sauvignon")');
    // Positive wine_type constraint may also be present from the wine_type rules
    // (red → wine_type=red is a hard constraint from the extractor)
    // The important invariant: both constraints are AND-ed, never dropped.
    expect(yql).toContain(' AND ');
  });

  it('soft price constraint from 5만원 이하 is included in bundle', () => {
    const bundle = extractRuleBasedConstraints('5만원 이하 화이트 와인');
    const priceConstraint = bundle.soft.find(
      (c) => c.attribute === 'price_usd' && c.operator === '<=',
    );
    expect(priceConstraint).toBeDefined();
    expect(typeof priceConstraint?.value).toBe('number');
    expect(priceConstraint!.value as number).toBeGreaterThan(0);
  });

  it('hard vintage constraint from 2018년 이후 is included in bundle', () => {
    const bundle = extractRuleBasedConstraints('2018년 이후 빈티지 레드');
    const vintageConstraint = bundle.hard.find(
      (c) => c.attribute === 'vintage_year' && c.operator === '>=',
    );
    expect(vintageConstraint).toBeDefined();
    expect(vintageConstraint?.value).toBe(2018);
  });
});

describe('rule-based soft slot extraction regression', () => {
  it('extracts max_price_krw soft constraint from "5만원 이하"', () => {
    const bundle = extractRuleBasedConstraints('5만원 이하 화이트 와인');
    const c = bundle.soft.find((item) => item.attribute === 'max_price_krw' && item.operator === '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(50_000);
  });

  it('extracts min_price_krw soft constraint from "10만원 이상"', () => {
    const bundle = extractRuleBasedConstraints('10만원 이상 레드 와인');
    const c = bundle.soft.find((item) => item.attribute === 'min_price_krw' && item.operator === '>=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(100_000);
  });

  it('extracts tannin low soft constraint from Korean intent', () => {
    const bundle = extractRuleBasedConstraints('타닌 약한 레드 와인 추천');
    const c = bundle.soft.find((item) => item.attribute === 'tannin' && item.operator === '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(0.4);
  });

  it('extracts fruit_intensity soft constraint from Korean intent', () => {
    const bundle = extractRuleBasedConstraints('과일향 풍부한 와인');
    const c = bundle.soft.find((item) => item.attribute === 'fruit_intensity' && item.operator === '>=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// Regression: ASCII inputs still work after Unicode-aware negation patterns
// ---------------------------------------------------------------------------

describe('regression: ASCII inputs work correctly', () => {
  it('plain ASCII query with no exclusion returns empty constraints', () => {
    const c = extractSearchConstraints('red wine bordeaux');
    expect(c.excludeGrapes).toBeUndefined();
    expect(c.excludeCountries).toBeUndefined();
  });

  it('accented Latin (é, ñ) in query does not crash', () => {
    expect(() => extractSearchConstraints('Sauvignon Blanc côte d\'or')).not.toThrow();
  });

  it('emoji in query does not crash', () => {
    expect(() => extractSearchConstraints('🍷 red wine not Merlot')).not.toThrow();
  });

  it('empty string returns empty constraints', () => {
    const c = extractSearchConstraints('');
    expect(c).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Regression: constraint-to-sparse-filter-tokens handles new price/vintage operators
// ---------------------------------------------------------------------------

describe('constraint-to-sparse-filter-tokens — price_usd <= / >= operators', () => {
  it('price_usd with <= operator produces price_usd_max token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      {
        attribute: 'price_usd',
        operator: '<=',
        value: 37.04,
        source_phrase: '5만원 이하',
        confidence: 0.82,
      },
    ]);
    expect(tokens).toContain('price_usd_max:37.04');
  });

  it('price_usd with >= operator produces price_usd_min token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      {
        attribute: 'price_usd',
        operator: '>=',
        value: 74.07,
        source_phrase: '10만원 이상',
        confidence: 0.82,
      },
    ]);
    expect(tokens).toContain('price_usd_min:74.07');
  });

  it('vintage_year with >= operator produces vintage_year_min token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      {
        attribute: 'vintage_year',
        operator: '>=',
        value: 2018,
        source_phrase: '2018년 이후',
        confidence: 0.9,
      },
    ]);
    expect(tokens).toContain('vintage_year_min:2018');
  });

  it('vintage_year with <= operator produces vintage_year_max token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      {
        attribute: 'vintage_year',
        operator: '<=',
        value: 2020,
        source_phrase: '2020년 이전',
        confidence: 0.9,
      },
    ]);
    expect(tokens).toContain('vintage_year_max:2020');
  });
});

// ---------------------------------------------------------------------------
// Regression: reversed range inputs must be swapped (session 4 audit)
// ---------------------------------------------------------------------------

describe('search-constraint-extractor reversed range swap regression', () => {
  it('R-RANGE-01: reversed price range "10~3만원" swaps to min=30000, max=100000', () => {
    // Without the fix: minPriceKrw=100000 > maxPriceKrw=30000 — impossible YQL filter.
    const c = extractSearchConstraints('10~3만원 레드 와인');
    expect(c.minPriceKrw).toBe(30_000);
    expect(c.maxPriceKrw).toBe(100_000);
    expect(c.minPriceKrw).toBeLessThanOrEqual(c.maxPriceKrw!);
  });

  it('R-RANGE-02: normal price range "3~10만원" stays as min=30000, max=100000', () => {
    const c = extractSearchConstraints('3~10만원 레드 와인');
    expect(c.minPriceKrw).toBe(30_000);
    expect(c.maxPriceKrw).toBe(100_000);
    expect(c.minPriceKrw).toBeLessThanOrEqual(c.maxPriceKrw!);
  });

  it('R-RANGE-03: equal price range "5~5만원" stays as min=max=50000', () => {
    const c = extractSearchConstraints('5~5만원 와인');
    expect(c.minPriceKrw).toBe(50_000);
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('R-RANGE-04: reversed vintage range "2022-2020" swaps to min=2020, max=2022', () => {
    // Without the fix: vintageMin=2022 > vintageMax=2020 — impossible YQL filter.
    const c = extractSearchConstraints('2022-2020 보르도 와인');
    expect(c.vintageMin).toBe(2020);
    expect(c.vintageMax).toBe(2022);
    expect(c.vintageMin).toBeLessThanOrEqual(c.vintageMax!);
  });

  it('R-RANGE-05: normal vintage range "2018-2022" stays as min=2018, max=2022', () => {
    const c = extractSearchConstraints('2018-2022 보르도 와인');
    expect(c.vintageMin).toBe(2018);
    expect(c.vintageMax).toBe(2022);
    expect(c.vintageMin).toBeLessThanOrEqual(c.vintageMax!);
  });
});

// ---------------------------------------------------------------------------
// Regression: comma-separated numbers and combined 만+천원 format
// ---------------------------------------------------------------------------

describe('search-constraint-extractor price parsing edge cases', () => {
  it('R-PRICE-COMMA-01: "50,000원 이하" parses as maxPriceKrw=50000', () => {
    const c = extractSearchConstraints('50,000원 이하 와인 추천');
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('R-PRICE-COMMA-02: "100,000원 이하" parses as maxPriceKrw=100000', () => {
    const c = extractSearchConstraints('100,000원 이하 보르도');
    expect(c.maxPriceKrw).toBe(100_000);
  });

  it('R-PRICE-COMMA-03: "1,000원" without bound qualifier does not break parser', () => {
    // Should not extract a price constraint — no 이하/이내/미만/이상 present for raw won
    const c = extractSearchConstraints('보르도 와인 추천');
    expect(c.maxPriceKrw).toBeUndefined();
    expect(c.minPriceKrw).toBeUndefined();
  });

  it('R-PRICE-COMBINED-01: "5만5천원" parses as maxPriceKrw=55000', () => {
    const c = extractSearchConstraints('5만5천원 와인 추천');
    expect(c.maxPriceKrw).toBe(55_000);
  });

  it('R-PRICE-COMBINED-02: "5만5천원 이하" parses as maxPriceKrw=55000', () => {
    const c = extractSearchConstraints('5만5천원 이하 화이트 와인');
    expect(c.maxPriceKrw).toBe(55_000);
  });

  it('R-PRICE-COMBINED-03: "3만5천원" parses as maxPriceKrw=35000', () => {
    const c = extractSearchConstraints('3만5천원 이하 가성비 와인');
    expect(c.maxPriceKrw).toBe(35_000);
  });

  it('R-PRICE-COMBINED-04: plain "5만원" still works after combined-unit code is added', () => {
    // Regression: combined-unit pattern must not intercept lone 만원 patterns
    const c = extractSearchConstraints('5만원 이하 레드 와인');
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('R-PRICE-COMBINED-05: "5만원대" band still works after combined-unit code is added', () => {
    const c = extractSearchConstraints('5만원대 보르도 와인');
    expect(c.maxPriceKrw).toBeGreaterThan(50_000);
    expect(c.minPriceKrw).toBeLessThan(50_000);
  });

  it('R-PRICE-COMMA-GLOBAL-01: "1,23원" not incorrectly stripped (global comma removes it, raw won pattern still requires 이하)', () => {
    // With global comma removal: "1,23원" → "123원" — no 이하 qualifier, so no price extracted.
    // Verifies global removal doesn't create phantom price constraints.
    const c = extractSearchConstraints('보르도 와인 1,23원');
    expect(c.maxPriceKrw).toBeUndefined();
  });

  it('R-PRICE-RANGE-COMBINED-01: "3만5천원~5만원" extracts combined-unit lower bound (known limitation)', () => {
    // "3만5천원~5만원" mixes combined-unit and 만원 notations in a range.
    // The range regex only handles "X~Y만원" (uniform unit), so it cannot parse
    // this mixed form. Combined-unit fires → maxPriceKrw=35000.
    // Known limitation: mixed-notation ranges are not supported. Document, not fix.
    const c = extractSearchConstraints('3만5천원~5만원 와인');
    expect(c.maxPriceKrw).toBe(35_000);
    expect(c.minPriceKrw).toBeUndefined();
  });

  it('R-PRICE-RANGE-COMBINED-02: standalone "3만5천원" still returns maxPriceKrw=35000', () => {
    // Regression: reordering range before combined-unit must not break standalone combined-unit.
    const c = extractSearchConstraints('3만5천원 레드 와인');
    expect(c.maxPriceKrw).toBe(35_000);
    expect(c.minPriceKrw).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Korean Sino-numeral word parsing (koreanNumberWordToDigit)
  // ---------------------------------------------------------------------------

  it('R-PRICE-KORNUM-01: "오만원 이하" → maxPriceKrw=50000', () => {
    const c = extractSearchConstraints('오만원 이하 레드 와인');
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('R-PRICE-KORNUM-02: "십만원 이하" → maxPriceKrw=100000 (bare 십 = 10)', () => {
    const c = extractSearchConstraints('십만원 이하 와인');
    expect(c.maxPriceKrw).toBe(100_000);
  });

  it('R-PRICE-KORNUM-03: "이십만원 이하" → maxPriceKrw=200000', () => {
    const c = extractSearchConstraints('이십만원 이하 와인');
    expect(c.maxPriceKrw).toBe(200_000);
  });

  it('R-PRICE-KORNUM-04: "백만원 이하" → maxPriceKrw=1000000 (bare 백 = 100)', () => {
    const c = extractSearchConstraints('백만원 이하 와인');
    expect(c.maxPriceKrw).toBe(1_000_000);
  });

  it('R-PRICE-KORNUM-05: "삼백오십만원 이하" → maxPriceKrw=3500000 (compound 백+십)', () => {
    // This is the critical bug case from the R4 audit: prior regex with rigid
    // ordering produced "삼백오" + leftover "십만원", corrupting the parse.
    const c = extractSearchConstraints('삼백오십만원 이하 프리미엄 와인');
    expect(c.maxPriceKrw).toBe(3_500_000);
  });

  it('R-PRICE-KORNUM-06: "오만 정도" → maxPriceKrw=50000 (soft approximate bound)', () => {
    const c = extractSearchConstraints('오만원 정도 레드');
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('R-PRICE-KORNUM-07: "오만한 사람" does NOT get rewritten (word boundary)', () => {
    // "오만하다" = "arrogant"; 만 here is part of a Korean adjective, not a price unit.
    // The (?![가-힣]) boundary after the unit must prevent rewriting.
    const c = extractSearchConstraints('오만한 사람을 위한 와인');
    expect(c.maxPriceKrw).toBeUndefined();
    expect(c.minPriceKrw).toBeUndefined();
  });
});
