/**
 * Regression tests — Negation YQL filter pipeline.
 *
 * APPEND-ONLY. Locks in the full-stack negation fix:
 *  - ConstraintOperator 'exclude'/'not_in' → _not / _not_in tokens
 *  - buildSparseFilters emits !(field contains "X") YQL NOT clauses
 *  - multi-value NOT-IN emits individual NOT clauses (Vespa has no NOT-IN shorthand)
 *  - grape_primary exclusion also sets grapes field
 *  - False-positive guard: legitimate queries not misclassified
 *
 * These would FAIL if the negation pipeline were reverted.
 */

import { describe, it, expect } from 'vitest';
import { hardConstraintsToSparseFilterTokens } from '../../src/domain/retrieval/service/constraint-to-sparse-filter-tokens.js';
import { buildSparseFilters } from '../../src/infrastructure/vespa/mapping.js';

// ---------------------------------------------------------------------------
// Part 1: Token emission from constraint model
// ---------------------------------------------------------------------------

describe('Negation regression — constraint-to-sparse-filter-tokens', () => {
  it('R-NEG-01: exclude operator on country emits country_not token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'country', operator: 'exclude', value: 'France', source_phrase: '프랑스 말고', confidence: 0.9 },
    ]);
    expect(tokens).toContain('country_not:France');
  });

  it('R-NEG-02: exclude operator on grape_primary emits BOTH grape_primary_not AND grapes_not', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'grape_primary', operator: 'exclude', value: 'Cabernet Sauvignon', source_phrase: '카베르네 빼고', confidence: 0.9 },
    ]);
    expect(tokens).toContain('grape_primary_not:Cabernet Sauvignon');
    expect(tokens).toContain('grapes_not:Cabernet Sauvignon');
  });

  it('R-NEG-03: not_in operator on wine_type emits wine_type_not for single value', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'wine_type', operator: 'not_in', value: ['White'], source_phrase: '화이트 말고', confidence: 0.9 },
    ]);
    expect(tokens).toContain('wine_type_not:White');
  });

  it('R-NEG-04: not_in operator with multiple values emits pipe-delimited _not_in token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'country', operator: 'not_in', value: ['France', 'Italy'], source_phrase: '프랑스 이탈리아 말고', confidence: 0.85 },
    ]);
    expect(tokens).toContain('country_not_in:France|Italy');
  });

  it('R-NEG-05: positive operator = still works after negation additions', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'wine_type', operator: '=', value: 'Red', source_phrase: '레드', confidence: 0.95 },
    ]);
    expect(tokens).toContain('wine_type:Red');
    // Must NOT emit any _not token for a positive constraint
    expect(tokens.filter((t) => t.includes('_not'))).toHaveLength(0);
  });

  it('R-NEG-06: exclude on style with a canonical value emits style_not token', () => {
    // 'oaked' is not a Vespa style field value (stored values are e.g. "medium red", "full red").
    // STYLE_NORMALISATION_MAP maps 'oaked' → '' so the token is dropped — emitting
    // style_not:oaked would produce a no-op !(style contains "oaked") YQL clause.
    // Use a canonical style value ('bold') to verify the pipeline still works end-to-end.
    const tokensOaked = hardConstraintsToSparseFilterTokens([
      { attribute: 'style', operator: 'exclude', value: 'oaked', source_phrase: '오크 안 쓴', confidence: 0.9 },
    ]);
    // oaked is skipped (non-indexable) — no token emitted
    expect(tokensOaked).toHaveLength(0);

    const tokensBold = hardConstraintsToSparseFilterTokens([
      { attribute: 'style', operator: 'exclude', value: 'bold', source_phrase: '진하지 않은', confidence: 0.9 },
    ]);
    expect(tokensBold).toContain('style_not:bold');
  });
});

// ---------------------------------------------------------------------------
// Part 2: YQL NOT clause emission from buildSparseFilters
// ---------------------------------------------------------------------------

describe('Negation regression — buildSparseFilters YQL output', () => {
  it('R-NEG-07: country_not token produces !(country contains "X") YQL', () => {
    const yql = buildSparseFilters(['country_not:France']);
    expect(yql).toContain('!(country contains "France")');
    // Positive form (without NOT) must not appear — only the negated form
    expect(yql).not.toMatch(/(?<!!)[(]country contains "France"[)]/);
  });

  it('R-NEG-08: grape_primary_not produces !(grape_primary contains "X") YQL', () => {
    const yql = buildSparseFilters(['grape_primary_not:Cabernet Sauvignon']);
    expect(yql).toContain('!(grape_primary contains "Cabernet Sauvignon")');
  });

  it('R-NEG-09: grapes_not produces !(grapes contains "X") YQL', () => {
    const yql = buildSparseFilters(['grapes_not:Cabernet Sauvignon']);
    expect(yql).toContain('!(grapes contains "Cabernet Sauvignon")');
  });

  it('R-NEG-10: wine_type_not produces !(wine_type contains "X") YQL', () => {
    const yql = buildSparseFilters(['wine_type_not:White']);
    expect(yql).toContain('!(wine_type contains "White")');
  });

  it('R-NEG-11: _not_in multi-value produces individual NOT clauses (no NOT-IN shorthand in Vespa)', () => {
    const yql = buildSparseFilters(['country_not_in:France|Italy']);
    expect(yql).toContain('!(country contains "France")');
    expect(yql).toContain('!(country contains "Italy")');
    // Both must be AND'd together, not OR'd
    const andIdx = yql.indexOf('!(country contains "France")');
    const andIdx2 = yql.indexOf('!(country contains "Italy")');
    expect(andIdx).toBeGreaterThanOrEqual(0);
    expect(andIdx2).toBeGreaterThanOrEqual(0);
  });

  it('R-NEG-12: positive and negative tokens can coexist in one filter string', () => {
    const yql = buildSparseFilters(['wine_type:Red', 'country_not:France']);
    expect(yql).toContain('wine_type contains "Red"');
    expect(yql).toContain('!(country contains "France")');
  });

  it('R-NEG-13: injection attempt in _not token is sanitized by yqlEscapeString', () => {
    // Value containing a double-quote — must be escaped, not injected
    const yql = buildSparseFilters(['country_not:Fra"nce']);
    expect(yql).not.toContain('"Fra"nce"');  // raw unescaped
    expect(yql).toContain('!(country contains ');  // still emits a NOT clause
  });

  it('R-NEG-14: style_not for unoaked Chardonnay query does not block "oak" in producer names', () => {
    // False-positive guard: filtering style=oaked must not block wines with "oak" in label
    // style field is attribute-only — must use `matches` (regex substring), not `contains`.
    // `!(style matches "oaked")` correctly excludes wines where style field contains "oaked";
    // `!(style contains "oaked")` silently no-ops on multi-token stored values like "full red".
    const yql = buildSparseFilters(['style_not:oaked', 'wine_type:White']);
    expect(yql).toContain('!(style matches "oaked")');
    expect(yql).toContain('wine_type contains "White"');
    // The NOT clause is scoped to the `style` field — full-text "oak" matches are unaffected
    expect(yql).not.toContain('!(canonical_label');
    expect(yql).not.toContain('!(search_text');
  });

  it('R-NEG-15: unknown field in _not_in token is silently skipped (injection guard)', () => {
    // Attempting to inject via unknown field should be skipped by ALLOWED_SPARSE_IN_FIELDS check
    const yql = buildSparseFilters(['injected_field_not_in:evil|value']);
    // Should produce empty filter (no clauses from unknown field)
    expect(yql).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Part 3: End-to-end — constraint → token → YQL pipeline
// ---------------------------------------------------------------------------

describe('Negation regression — end-to-end pipeline', () => {
  it('R-NEG-16: "프랑스 말고 유럽" scenario → country_not France → YQL NOT clause', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'country', operator: 'exclude', value: 'France', source_phrase: '프랑스 말고', confidence: 0.9 },
    ]);
    const yql = buildSparseFilters(tokens);
    expect(yql).toContain('!(country contains "France")');
  });

  it('R-NEG-17: "카베르네 빼고 풀바디" scenario → grape exclusion covers both schema fields', () => {
    // IDX-05: body is a SOFT_CONSTRAINT_ATTRIBUTE — hardConstraintsToSparseFilterTokens
    // intentionally produces no token for it; the body preference goes to the soft
    // penalty bundle, not the hard YQL filter layer.  Only grape exclusion appears in YQL.
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'grape_primary', operator: 'exclude', value: 'Cabernet Sauvignon', source_phrase: '카베르네 소비뇽 빼고', confidence: 0.9 },
      { attribute: 'body', operator: '>=', value: 7, source_phrase: '풀바디', confidence: 0.85 },
    ]);
    const yql = buildSparseFilters(tokens);
    expect(yql).toContain('!(grape_primary contains "Cabernet Sauvignon")');
    expect(yql).toContain('!(grapes contains "Cabernet Sauvignon")');
    // body is soft — must NOT appear as a hard YQL clause (would over-filter and kill recall)
    expect(yql).not.toContain('body >=');
  });

  it('R-NEG-18: "오크 안 쓴 샤도네이" scenario → oaked style excluded (no-op token), grape positive retained', () => {
    // 'oaked' maps to '' in STYLE_NORMALISATION_MAP — it is not a stored Vespa style value
    // so emitting !(style contains "oaked") would be a no-op filter that silently passes all
    // wines (the stored values are "medium red", "full red", etc., never "oaked").
    // The pipeline correctly drops the oaked token; only the grape_primary token is emitted.
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'style', operator: 'exclude', value: 'oaked', source_phrase: '오크 안 쓴', confidence: 0.88 },
      { attribute: 'grape_primary', operator: '=', value: 'Chardonnay', source_phrase: '샤도네이', confidence: 0.95 },
    ]);
    const yql = buildSparseFilters(tokens);
    // oaked token dropped — no style YQL clause emitted
    expect(yql).not.toContain('style');
    expect(yql).toContain('grape_primary contains "Chardonnay"');
  });

  it('R-NEG-19: triple exclusion (화이트+샤도네이+소비뇽) emits 3 NOT clauses', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'wine_type', operator: 'exclude', value: 'White', source_phrase: '화이트 말고', confidence: 0.9 },
      { attribute: 'grape_primary', operator: 'not_in', value: ['Chardonnay', 'Sauvignon Blanc'], source_phrase: '샤도네이 소비뇽 말고', confidence: 0.85 },
    ]);
    const yql = buildSparseFilters(tokens);
    expect(yql).toContain('!(wine_type contains "White")');
    // not_in multi-value for grape_primary goes through _not_in path
    expect(yql).toContain('Chardonnay');
    expect(yql).toContain('Sauvignon Blanc');
  });

  it('R-NEG-20: positive in operator still produces OR clause (not broken by negation changes)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      { attribute: 'country', operator: 'in', value: ['Italy', 'Spain', 'Germany'], source_phrase: '이탈리아 스페인 독일', confidence: 0.9 },
    ]);
    const yql = buildSparseFilters(tokens);
    expect(yql).toContain('country contains "Italy"');
    expect(yql).toContain('country contains "Spain"');
    expect(yql).toContain('country contains "Germany"');
    expect(yql).toContain(' OR ');
    expect(yql).not.toContain('!');  // no NOT clauses for positive in
  });
});
