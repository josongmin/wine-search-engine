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

  it('ignores unmapped attributes like free-text region', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'region', operator: '=', value: 'Napa' }),
    ]);
    expect(tokens).toEqual([]);
  });
});
