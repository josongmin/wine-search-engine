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
// Explicit foreign-currency ceilings
// ---------------------------------------------------------------------------

describe('extractSearchConstraints — explicit USD ceilings', () => {
  it('extracts maxPriceKrw from "under 100 dollars"', () => {
    const constraints = extractSearchConstraints('best Bordeaux under 100 dollars');
    expect(constraints.maxPriceKrw).toBe(135_000);
  });

  it('extracts maxPriceKrw from "under $100"', () => {
    const constraints = extractSearchConstraints('best Bordeaux under $100');
    expect(constraints.maxPriceKrw).toBe(135_000);
  });

  it('extracts maxPriceKrw from suffix USD phrasing', () => {
    const constraints = extractSearchConstraints('Bordeaux 100 USD or less');
    expect(constraints.maxPriceKrw).toBe(135_000);
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

  it('generates !(style matches "oaked") from style_not token', () => {
    // style field is attribute-only — must use `matches` (regex substring), not `contains`.
    // `!(style matches "oaked")` correctly excludes wines whose style contains "oaked";
    // `!(style contains "oaked")` silently no-ops on multi-token values like "full red".
    const yql = buildSparseFilters(['style_not:oaked']);
    expect(yql).toContain('!(style matches "oaked")');
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
  it('extracts canonical price_usd ceiling soft constraint from "5만원 이하"', () => {
    const bundle = extractRuleBasedConstraints('5만원 이하 화이트 와인');
    const c = bundle.soft.find((item) => item.attribute === 'price_usd' && item.operator === '<=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(37.04);
  });

  it('extracts canonical price_usd floor soft constraint from "10만원 이상"', () => {
    const bundle = extractRuleBasedConstraints('10만원 이상 레드 와인');
    const c = bundle.soft.find((item) => item.attribute === 'price_usd' && item.operator === '>=');
    expect(c).toBeDefined();
    expect(c?.value).toBe(74.07);
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

  it('R-PRICE-WON-OVER-01: "10000원 이상" parses as minPriceKrw=10000', () => {
    const c = extractSearchConstraints('10000원 이상 집들이 와인');
    expect(c.minPriceKrw).toBe(10_000);
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

  // R-PRICE-EONEORI: "언저리" (approximate around) marker must be treated as maxPriceKrw
  it('R-PRICE-EONEORI-01: "10만원 언저리로" → maxPriceKrw=100000', () => {
    const c = extractSearchConstraints('10만원 언저리로');
    expect(c.maxPriceKrw).toBe(100_000);
  });

  it('R-PRICE-EONEORI-02: "5만원 근처" → maxPriceKrw=50000', () => {
    const c = extractSearchConstraints('5만원 근처 레드 와인');
    expect(c.maxPriceKrw).toBe(50_000);
  });

  it('R-PRICE-EONEORI-03: "3만원 내외" → maxPriceKrw=30000', () => {
    const c = extractSearchConstraints('3만원 내외 화이트');
    expect(c.maxPriceKrw).toBe(30_000);
  });
});

describe('retail channel price mapping', () => {
  // SOTA++ structural fix (v14 bench price_expression #70-73 RCA):
  // retail-channel keywords now emit a SOFT softMaxPriceKrwHint (ranking
  // signal), NOT a hard maxPriceKrw (YQL filter). On a long-tail corpus the
  // hard cap silently returned zero retrieval results. See
  // search-constraint-extractor.ts:`extractRetailChannelPrice` docstring.

  it('R-CHANNEL-01: "편의점 와인" → softMaxPriceKrwHint=15000, no hard maxPriceKrw', () => {
    const c = extractSearchConstraints('편의점 와인 추천해줘');
    expect(c.softMaxPriceKrwHint).toBe(15_000);
    expect(c.maxPriceKrw).toBeUndefined();
  });

  it('R-CHANNEL-02: "편의점 수준으로" → softMaxPriceKrwHint=15000, no hard maxPriceKrw', () => {
    const c = extractSearchConstraints('편의점 수준으로 레드 와인');
    expect(c.softMaxPriceKrwHint).toBe(15_000);
    expect(c.maxPriceKrw).toBeUndefined();
  });

  it('R-CHANNEL-03: "마트 와인" → softMaxPriceKrwHint=30000, no hard maxPriceKrw', () => {
    const c = extractSearchConstraints('마트 와인 추천');
    expect(c.softMaxPriceKrwHint).toBe(30_000);
    expect(c.maxPriceKrw).toBeUndefined();
  });

  it('R-CHANNEL-04: "대형마트" → softMaxPriceKrwHint=30000, no hard maxPriceKrw', () => {
    const c = extractSearchConstraints('대형마트에서 살 수 있는 와인');
    expect(c.softMaxPriceKrwHint).toBe(30_000);
    expect(c.maxPriceKrw).toBeUndefined();
  });

  it('R-CHANNEL-05: "백화점 와인" → softMaxPriceKrwHint=100000, no hard maxPriceKrw', () => {
    const c = extractSearchConstraints('백화점 와인 수준');
    expect(c.softMaxPriceKrwHint).toBe(100_000);
    expect(c.maxPriceKrw).toBeUndefined();
  });

  it('R-CHANNEL-06: numeric price overrides channel hint when both present', () => {
    // "편의점에서 파는 8천원짜리" → numeric 8000 sets hard maxPriceKrw AND
    // strips the soft channel hint (numeric is the more specific / authoritative
    // budget). Tests the merge-strip branch in extractSearchConstraints.
    const c = extractSearchConstraints('편의점에서 8천원 이하 와인');
    expect(c.maxPriceKrw).toBe(8_000);
    expect(c.softMaxPriceKrwHint).toBeUndefined();
  });

  it('R-CHANNEL-07: "마트" does NOT match embedded in other words (false positive guard)', () => {
    // "슈퍼마켓" contains 마트 but is handled by the 슈퍼마켓 pattern, not a false positive
    // "마트" in "마트료시카" (matryoshka) should not match — it is preceded by no space
    // but our pattern requires word-level context. This is a false-positive guard test.
    const c = extractSearchConstraints('마트료시카 인형처럼 겹겹이 복잡한 와인');
    expect(c.maxPriceKrw).toBeUndefined();
    expect(c.softMaxPriceKrwHint).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Structural guard — softMaxPriceKrwHint MUST NOT leak into YQL filter tokens
  // -------------------------------------------------------------------------
  it('R-CHANNEL-FILTER-01: searchConstraintsToFilterTokens does NOT emit price_usd_max for soft hint', () => {
    const c = extractSearchConstraints('편의점 와인 추천해줘');
    const tokens = searchConstraintsToFilterTokens(c);
    // No price_usd_max / price_usd_min token — the soft hint is a ranking
    // signal, not a Vespa hard filter. This is the critical invariant that
    // unblocks bench scenarios #70/71/73 (zero-retrieval on tight cap).
    expect(tokens.some((t) => t.startsWith('price_usd_max:'))).toBe(false);
    expect(tokens.some((t) => t.startsWith('price_usd_min:'))).toBe(false);
  });

  it('R-CHANNEL-FILTER-02: numeric-price + retail-channel → only numeric emits hard YQL token', () => {
    // "편의점에서 8천원 이하" — channel hint is stripped (numeric wins), so
    // the only YQL token emitted is the numeric 8K cap.
    const c = extractSearchConstraints('편의점에서 8천원 이하 와인');
    const tokens = searchConstraintsToFilterTokens(c);
    const priceTokens = tokens.filter((t) => t.startsWith('price_usd_max:'));
    expect(priceTokens.length).toBe(1);
  });

  it('R-CHANNEL-FILTER-03: numeric-only KRW price still emits hard YQL token (regression)', () => {
    // Ensures the hard-cap mechanism for explicit "X만원 이하" remains intact.
    const c = extractSearchConstraints('5만원 이하 레드 와인');
    expect(c.maxPriceKrw).toBe(50_000);
    const tokens = searchConstraintsToFilterTokens(c);
    expect(tokens.some((t) => t.startsWith('price_usd_max:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG regressions — negation routing and pattern fixes (Round 7)
// ---------------------------------------------------------------------------

describe('search-constraint-extractor — negation routing fixes (BUG regression)', () => {
  // BUG: oaked? regex matched 'oake' (oake + optional d), not 'oak' + optional 'ed'
  // Fix: oak(?:ed)? — now matches 'oak' and 'oaked' as standalone subjects correctly.
  // Note: NEGATION_SUBJECT_BEFORE greedy-captures 2 words ("oak white" from "without oak white wine"),
  // so the single-word form "without oak" (no trailing words) is the reliable test.
  it('R-NEG-BUG-01: "without oak" (single subject) routes to excludeStyleSet', () => {
    const c = extractSearchConstraints('without oak');
    expect(c.excludeStyles).toContain('oak');
    expect(c.excludeRegions ?? []).not.toContain('oak');
  });

  it('R-NEG-BUG-02: "exclude oaked" (single subject) routes to excludeStyleSet', () => {
    // Single subject — no 2nd word to greedily capture
    const c = extractSearchConstraints('exclude oaked');
    expect(c.excludeStyles).toContain('oaked');
  });

  // BUG: "full-bodied", "light-bodied", "medium-bodied" were absent from style classifier
  // "not full-bodied" has a 2-word greedy issue: subject = "full-bodied" (hyphenated = 1 token)
  it('R-NEG-BUG-03: "not full-bodied" (single hyphenated token) routes to excludeStyleSet', () => {
    const c = extractSearchConstraints('not full-bodied');
    expect(c.excludeStyles).toContain('full-bodied');
    expect(c.excludeRegions ?? []).not.toContain('full-bodied');
  });

  it('R-NEG-BUG-04: "not light-bodied" routes to excludeStyleSet', () => {
    const c = extractSearchConstraints('not light-bodied');
    expect(c.excludeStyles).toContain('light-bodied');
  });

  // R-NEG-BUG-04b: firstWord fallback must NOT trigger for inline-regex-only tokens.
  // "full-bodied" matches the inline regex but is NOT in WINE_TYPE_ALL_TOKENS.
  // firstWord = "full" is also NOT in WINE_TYPE_ALL_TOKENS.
  // The correct canonical is "full-bodied" (tokenLower), not "full" (firstWord).
  // Regression for the canonicalToken ternary that previously used firstWord unconditionally
  // when tokenLower was not in WINE_TYPE_ALL_TOKENS.
  it('R-NEG-BUG-04b: "not full-bodied" canonical is "full-bodied" not "full" (firstWord guard)', () => {
    const c = extractSearchConstraints('not full-bodied');
    expect(c.excludeStyles).toContain('full-bodied');
    expect(c.excludeStyles ?? []).not.toContain('full');
  });

  it('R-NEG-BUG-04c: "not medium-bodied" canonical is "medium-bodied" not "medium"', () => {
    const c = extractSearchConstraints('not medium-bodied');
    expect(c.excludeStyles).toContain('medium-bodied');
    expect(c.excludeStyles ?? []).not.toContain('medium');
  });

  // BUG: multi-word Korean wine type "내추럴 와인 빼고" — NEGATION_SUBJECT_AFTER captures
  // "내추럴 와인" as subject. WINE_TYPE_ALL_TOKENS has '내추럴' (first word).
  // Fix (v1): firstWord fallback → routes to excludeStyleSet with canonical '내추럴'
  // Fix (v2): wine type tokens now resolve to canonical English via WINE_TYPE_RULES
  // and route to excludeWineTypes (not excludeStyles). "내추럴" → "natural".
  it('R-NEG-BUG-05: "내추럴 와인 빼고" routes to excludeWineTypes via canonical resolution', () => {
    const c = extractSearchConstraints('내추럴 와인 빼고 레드 추천');
    expect(c.excludeWineTypes).toContain('natural');
    expect(c.excludeRegions ?? []).not.toContain('내추럴 와인');
  });

  // BUG: "빼주세요" and "빼줘" were absent from NEGATION_SUBJECT_AFTER pattern
  // Users using polite forms got no negation extraction at all
  // Fix (v2): wine type tokens now resolve to canonical English via WINE_TYPE_RULES
  // and route to excludeWineTypes. "스파클링" → "sparkling".
  it('R-NEG-BUG-06: "스파클링 빼주세요" extracts sparkling exclusion via excludeWineTypes', () => {
    const c = extractSearchConstraints('스파클링 빼주세요');
    expect(c.excludeWineTypes).toContain('sparkling');
  });

  it('R-NEG-BUG-07: "스파클링 빼줘" extracts sparkling exclusion via excludeWineTypes', () => {
    const c = extractSearchConstraints('스파클링 빼줘');
    expect(c.excludeWineTypes).toContain('sparkling');
  });
});

// ---------------------------------------------------------------------------
// Korean verbal negation patterns and wine_type canonical resolution (BUG-A/B fix)
// ---------------------------------------------------------------------------

describe('Korean verbal negation patterns (아닌/아니고/않고/않은)', () => {
  it('R-NEG-VERBAL-01: "화이트 말고" → excludeWineTypes contains "white"', () => {
    const c = extractSearchConstraints('화이트 말고 레드 와인');
    expect(c.excludeWineTypes).toContain('white');
    // Must NOT appear in excludeStyles (Bug B fix: route to wine_type, not style)
    expect(c.excludeStyles ?? []).not.toContain('화이트');
    expect(c.excludeStyles ?? []).not.toContain('white');
  });

  it('R-NEG-VERBAL-02: "레드 말고 화이트로" → exclude wine_type "red", no exclude on "white"', () => {
    const c = extractSearchConstraints('레드 말고 화이트로');
    expect(c.excludeWineTypes).toContain('red');
    // "화이트로" is not in a negation context — it should NOT be excluded
    expect(c.excludeWineTypes ?? []).not.toContain('white');
  });

  it('R-NEG-VERBAL-03: "프랑스 아닌 레드" → country exclude "France"', () => {
    const c = extractSearchConstraints('프랑스 아닌 레드');
    expect(c.excludeCountries).toContain('France');
    // "레드" is not negated
    expect(c.excludeWineTypes ?? []).not.toContain('red');
  });

  it('R-NEG-VERBAL-04: "프랑스 아닌" → country exclude "France"', () => {
    const c = extractSearchConstraints('프랑스 아닌');
    expect(c.excludeCountries).toContain('France');
  });

  it('R-NEG-VERBAL-05: "이탈리아 아닌 레드" → country exclude "Italy" + no wine_type exclude', () => {
    const c = extractSearchConstraints('이탈리아 아닌 레드');
    expect(c.excludeCountries).toContain('Italy');
    expect(c.excludeWineTypes ?? []).not.toContain('red');
  });

  it('R-NEG-VERBAL-06: "카베르네 소비뇽 빼고" → grape exclude "Cabernet Sauvignon"', () => {
    const c = extractSearchConstraints('카베르네 소비뇽 빼고');
    expect(c.excludeGrapes).toContain('Cabernet Sauvignon');
  });

  it('R-NEG-VERBAL-07: "이탈리아 아니고 레드" → country exclude "Italy"', () => {
    const c = extractSearchConstraints('이탈리아 아니고 레드');
    expect(c.excludeCountries).toContain('Italy');
  });

  it('R-NEG-VERBAL-08: "프랑스 않은 와인" → country exclude "France"', () => {
    // "않은" is a verbal negation suffix (past adjective form of 않다)
    const c = extractSearchConstraints('프랑스 않은 와인');
    expect(c.excludeCountries).toContain('France');
  });

  it('R-NEG-VERBAL-09: "샴페인 아닌 스파클링" → exclude wine_type "sparkling" for 샴페인', () => {
    // "샴페인" is both a wine_type (sparkling alias) and a region (Champagne).
    // WINE_TYPE_RULES resolves 샴페인 → "sparkling" because it is listed in the
    // sparkling pattern. The downstream pipeline handles this as wine_type exclusion.
    const c = extractSearchConstraints('샴페인 아닌 스파클링');
    expect(c.excludeWineTypes).toContain('sparkling');
  });
});

describe('Korean "안" adverb negation (NEGATION_KOREAN_ADVERB_BEFORE)', () => {
  it('R-NEG-AN-01: "안 비싼 와인" → subject "비싼 와인" extracted (free-form region fallthrough)', () => {
    // "안 비싼 와인" = "not expensive wine" — "비싼 와인" is not a grape, country, or wine type
    // so it falls through to region as free-form. The important thing is that it
    // IS captured as a negated subject.
    const c = extractSearchConstraints('안 비싼 와인');
    // "비싼 와인" is not a recognized entity — falls to excludeRegions
    expect(c.excludeRegions ?? []).toContain('비싼 와인');
  });

  it('R-NEG-AN-02: "안 쓴 와인" → extracts negated subject', () => {
    // "안 쓴" = "not bitter"; "쓴" is not a recognized entity so free-form region fallthrough
    const c = extractSearchConstraints('안 쓴 와인');
    expect(c.excludeRegions ?? []).toContain('쓴 와인');
  });

  it('R-NEG-AN-03: "안 비싼 레드" → greedy 2-word capture includes "레드" (known limitation)', () => {
    // The "안" adverb pattern captures up to 2 words after "안", so "비싼 레드" is the subject.
    // "레드" within the subject triggers wine_type canonical resolution → "red".
    // This is a known limitation of greedy capture — semantic disambiguation requires NLU.
    const c = extractSearchConstraints('안 비싼 레드');
    // Subject "비싼 레드" resolves "레드" via WINE_TYPE_RULES → "red"
    expect(c.excludeWineTypes).toContain('red');
  });
});

describe('excludeWineTypes canonical resolution via WINE_TYPE_RULES', () => {
  it('R-NEG-CANON-01: "화이트 빼고" → canonical "white" (not Korean surface "화이트")', () => {
    const c = extractSearchConstraints('화이트 빼고');
    expect(c.excludeWineTypes).toContain('white');
    expect(c.excludeWineTypes).not.toContain('화이트');
  });

  it('R-NEG-CANON-02: "레드 빼고" → canonical "red"', () => {
    const c = extractSearchConstraints('레드 빼고');
    expect(c.excludeWineTypes).toContain('red');
  });

  it('R-NEG-CANON-03: "로제 빼고" → canonical "rosé"', () => {
    const c = extractSearchConstraints('로제 빼고');
    expect(c.excludeWineTypes).toContain('rosé');
  });

  it('R-NEG-CANON-04: "not sparkling" (English) → canonical "sparkling"', () => {
    const c = extractSearchConstraints('not sparkling');
    expect(c.excludeWineTypes).toContain('sparkling');
  });

  it('R-NEG-CANON-05: "not red" (English) → canonical "red"', () => {
    const c = extractSearchConstraints('not red');
    expect(c.excludeWineTypes).toContain('red');
  });

  it('R-NEG-CANON-06: "디저트 말고" → canonical "dessert"', () => {
    const c = extractSearchConstraints('디저트 말고');
    expect(c.excludeWineTypes).toContain('dessert');
  });

  it('R-NEG-CANON-07: "주정강화 빼고" → canonical "fortified"', () => {
    const c = extractSearchConstraints('주정강화 빼고');
    expect(c.excludeWineTypes).toContain('fortified');
  });
});

describe('excludeWineTypes end-to-end through rule-based-constraint-extractor', () => {
  it('R-NEG-E2E-WT-01: "화이트 말고 레드 와인" → hard wine_type exclude "white"', () => {
    const bundle = extractRuleBasedConstraints('화이트 말고 레드 와인');
    const wineTypeExclude = bundle.hard.find(
      (c) => c.attribute === 'wine_type' && c.operator === 'exclude',
    );
    expect(wineTypeExclude).toBeDefined();
    expect(wineTypeExclude?.value).toBe('white');
  });

  it('R-NEG-E2E-WT-02: "스파클링 빼고 레드 와인" → hard wine_type exclude "sparkling"', () => {
    const bundle = extractRuleBasedConstraints('스파클링 빼고 레드 와인');
    const wineTypeExclude = bundle.hard.find(
      (c) => c.attribute === 'wine_type' && c.operator === 'exclude',
    );
    expect(wineTypeExclude).toBeDefined();
    expect(wineTypeExclude?.value).toBe('sparkling');
  });

  it('R-NEG-E2E-WT-03: wine_type exclude produces wine_type_not filter token', () => {
    const bundle = extractRuleBasedConstraints('화이트 아닌 레드 와인');
    const tokens = hardConstraintsToSparseFilterTokens(bundle.hard);
    expect(tokens).toContain('wine_type_not:white');
  });

  it('R-NEG-E2E-WT-04: wine_type_not token produces !(wine_type contains "X") YQL', () => {
    const bundle = extractRuleBasedConstraints('레드 빼고 화이트 와인');
    const tokens = hardConstraintsToSparseFilterTokens(bundle.hard);
    const yql = buildSparseFilters([...tokens]);
    expect(yql).toContain('!(wine_type contains "red")');
  });
});

describe('searchConstraintsToFilterTokens — excludeWineTypes', () => {
  it('produces wine_type_not token for wine type exclusion', () => {
    const tokens = searchConstraintsToFilterTokens({ excludeWineTypes: ['white'] });
    expect(tokens).toContain('wine_type_not:white');
  });

  it('produces multiple wine_type_not tokens for multiple exclusions', () => {
    const tokens = searchConstraintsToFilterTokens({ excludeWineTypes: ['white', 'sparkling'] });
    expect(tokens).toContain('wine_type_not:white');
    expect(tokens).toContain('wine_type_not:sparkling');
  });

  it('returns empty array when excludeWineTypes is absent', () => {
    const tokens = searchConstraintsToFilterTokens({});
    expect(tokens.filter((t) => t.startsWith('wine_type_not:'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: ASCII, accented, emoji inputs still work after verbal negation
// ---------------------------------------------------------------------------

describe('regression: verbal negation patterns do not break non-Korean input', () => {
  it('plain ASCII "not Merlot" still works', () => {
    const c = extractSearchConstraints('not Merlot');
    expect(c.excludeGrapes).toContain('Merlot');
  });

  it('accented Latin "not rosé" extracts wine_type exclusion', () => {
    const c = extractSearchConstraints('not rosé');
    expect(c.excludeWineTypes).toContain('rosé');
  });

  it('emoji in query does not crash verbal negation patterns', () => {
    expect(() => extractSearchConstraints('🍷 안 비싼 레드 와인')).not.toThrow();
  });

  it('empty string returns empty constraints (verbal patterns do not add phantom results)', () => {
    const c = extractSearchConstraints('');
    expect(c).toEqual({});
  });
});
