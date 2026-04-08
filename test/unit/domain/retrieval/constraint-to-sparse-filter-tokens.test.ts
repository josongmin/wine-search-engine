import { describe, it, expect } from 'vitest';
import { hardConstraintsToSparseFilterTokens } from '../../../../src/domain/retrieval/service/constraint-to-sparse-filter-tokens.js';
import type { NormalizedConstraint } from '../../../../src/domain/shared/types/index.js';

function c(partial: Omit<NormalizedConstraint, 'source_phrase' | 'confidence'> & Partial<Pick<NormalizedConstraint, 'source_phrase' | 'confidence'>>): NormalizedConstraint {
  return {
    source_phrase: 'test',
    confidence: 0.9,
    ...partial,
  };
}

describe('hardConstraintsToSparseFilterTokens', () => {
  it('maps wine_type and country', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'wine_type', operator: '=', value: 'red' }),
      c({ attribute: 'country', operator: '=', value: 'France' }),
    ]);
    expect(tokens).toEqual(['wine_type:red', 'country:France']);
  });

  it('maps numeric ranges for price and vintage', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({
        attribute: 'price_usd',
        operator: 'range',
        value: { min: 10, max: 50 },
      }),
      c({
        attribute: 'vintage_year',
        operator: 'range',
        value: { min: 2015, max: 2018 },
      }),
    ]);
    expect(tokens).toContain('price_usd_min:10');
    expect(tokens).toContain('price_usd_max:50');
    expect(tokens).toContain('vintage_year_min:2015');
    expect(tokens).toContain('vintage_year_max:2018');
  });

  it('maps region as a filter token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'region', operator: '=', value: 'Napa' }),
    ]);
    expect(tokens).toEqual(['region:Napa']);
  });

  it('ignores truly unmapped attributes like free-text notes', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'notes', operator: '=', value: 'something' }),
    ]);
    expect(tokens).toEqual([]);
  });

  it('emits pipe-delimited _in token for multi-value in constraints', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'country', operator: 'in', value: ['France', 'Italy'] }),
    ]);
    expect(tokens).toEqual(['country_in:France|Italy']);
  });

  it('emits _not token for exclude operator on string attributes', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'country', operator: 'exclude', value: 'France' }),
    ]);
    expect(tokens).toEqual(['country_not:France']);
  });

  it('emits _not token for exclude on wine_type', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'wine_type', operator: 'exclude', value: 'red' }),
    ]);
    expect(tokens).toEqual(['wine_type_not:red']);
  });

  it('emits dual _not tokens for grape_primary exclude (covers both schema fields)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'grape_primary', operator: 'exclude', value: 'Merlot' }),
    ]);
    expect(tokens).toContain('grape_primary_not:Merlot');
    expect(tokens).toContain('grapes_not:Merlot');
  });

  it('emits single _not token for not_in with one value', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'not_in', value: ['bold'] }),
    ]);
    expect(tokens).toEqual(['style_not:bold']);
  });

  it('emits pipe-delimited _not_in token for multi-value not_in constraints', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'country', operator: 'not_in', value: ['France', 'Italy'] }),
    ]);
    expect(tokens).toEqual(['country_not_in:France|Italy']);
  });

  it('skips empty strings in not_in array', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'country', operator: 'not_in', value: ['', ''] }),
    ]);
    expect(tokens).toEqual([]);
  });
});
