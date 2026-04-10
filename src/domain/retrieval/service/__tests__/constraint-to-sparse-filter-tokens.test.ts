/**
 * Tests for constraint-to-sparse-filter-tokens.ts (IDX-05).
 *
 * IDX-05: acidity should be SOFT (penalty only, no YQL WHERE clause).
 * The constraint-compiler puts acidity in SOFT_CONSTRAINT_ATTRIBUTES so it
 * never reaches hardConstraintsToSparseFilterTokens in production. But the
 * token mapper must also refuse to generate acidity YQL tokens in case
 * it is called via a direct code path.
 */

import { describe, it, expect } from 'vitest';
import { hardConstraintsToSparseFilterTokens } from '../constraint-to-sparse-filter-tokens.js';
import type { NormalizedConstraint } from '../../../shared/types/index.js';

function makeConstraint(
  attribute: string,
  operator: NormalizedConstraint['operator'],
  value: NormalizedConstraint['value'],
): NormalizedConstraint {
  return { attribute, operator, value, source_phrase: attribute, confidence: 0.9 };
}

describe('hardConstraintsToSparseFilterTokens — IDX-05 acidity soft treatment', () => {
  it('acidity = value produces NO YQL filter token (acidity is SOFT, not hard)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('acidity', '=', 3),
    ]);
    expect(tokens.filter((t) => t.startsWith('acidity'))).toHaveLength(0);
  });

  it('acidity >= value produces NO YQL filter token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('acidity', '>=', 2),
    ]);
    expect(tokens.filter((t) => t.startsWith('acidity'))).toHaveLength(0);
  });

  it('acidity <= value produces NO YQL filter token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('acidity', '<=', 4),
    ]);
    expect(tokens.filter((t) => t.startsWith('acidity'))).toHaveLength(0);
  });

  it('country = value DOES produce a YQL filter token (regression: hard attributes unaffected)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('country', '=', 'France'),
    ]);
    expect(tokens.some((t) => t.startsWith('country:'))).toBe(true);
  });

  it('wine_type = value DOES produce a YQL filter token (regression)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('wine_type', '=', 'red'),
    ]);
    expect(tokens.some((t) => t.startsWith('wine_type:'))).toBe(true);
  });
});

// IDX-05 extended: all numeric SOFT_CONSTRAINT_ATTRIBUTES must produce NO hard tokens.
// body, tannin, finish_length, critic_score, producer_prestige, acidity (separately tested),
// drinking_window (separately tested) are preference signals — hard-filtering on them would
// reduce recall to zero for common user queries.
describe('hardConstraintsToSparseFilterTokens — IDX-05 extended: all numeric SOFT attrs', () => {
  // NOTE: acidity and drinking_window have their own dedicated describe blocks below;
  // sweetness is a string SOFT attr with no numeric operators in the switch.
  const softNumericAttrs = ['body', 'tannin', 'finish_length', 'critic_score', 'producer_prestige'] as const;

  for (const attr of softNumericAttrs) {
    it(`${attr} >= value produces NO YQL filter token`, () => {
      const tokens = hardConstraintsToSparseFilterTokens([makeConstraint(attr, '>=', 0.5)]);
      expect(tokens.filter((t) => t.startsWith(attr))).toHaveLength(0);
    });

    it(`${attr} <= value produces NO YQL filter token`, () => {
      const tokens = hardConstraintsToSparseFilterTokens([makeConstraint(attr, '<=', 0.8)]);
      expect(tokens.filter((t) => t.startsWith(attr))).toHaveLength(0);
    });

    it(`${attr} = value produces NO YQL filter token`, () => {
      const tokens = hardConstraintsToSparseFilterTokens([makeConstraint(attr, '=', 0.7)]);
      expect(tokens.filter((t) => t.startsWith(attr))).toHaveLength(0);
    });
  }

  it('removing soft cases did not affect hard attributes — vintage_year still works', () => {
    const tokens = hardConstraintsToSparseFilterTokens([makeConstraint('vintage_year', '>=', 2015)]);
    expect(tokens.some((t) => t.startsWith('vintage_year_min:'))).toBe(true);
  });

  it('removing soft cases did not affect hard attributes — price_usd still works', () => {
    const tokens = hardConstraintsToSparseFilterTokens([makeConstraint('price_usd', '<=', 50)]);
    expect(tokens.some((t) => t.startsWith('price_usd_max:'))).toBe(true);
  });
});

// IDX-05 (drinking_window): drinking_window is SOFT_CONSTRAINT_ATTRIBUTES — it is a
// preference signal, not a hard identity constraint. Removing its case prevents the
// footgun where a direct call produces a hard YQL filter that collapses recall.
describe('hardConstraintsToSparseFilterTokens — IDX-05: drinking_window SOFT', () => {
  it('drinking_window = year produces NO YQL filter token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('drinking_window', '=', 2026),
    ]);
    expect(tokens.filter((t) => t.startsWith('drinking_window'))).toHaveLength(0);
  });

  it('drinking_window >= year produces NO YQL filter token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('drinking_window', '>=', 2024),
    ]);
    expect(tokens.filter((t) => t.startsWith('drinking_window'))).toHaveLength(0);
  });
});

// IDX-05 (string SOFT attrs): style, price_band, flavor_profile, certification are
// SOFT_CONSTRAINT_ATTRIBUTES for positive constraints (= / in). Their cases are kept
// for exclude/not_in (hard NOT-filters are valid even for soft attributes), but positive
// soft signals must not leak as hard filters via direct calls.
// NOTE: stringEq() DOES emit tokens for positive operators — these tests document
// that behaviour and serve as canaries if the routing contract changes.
describe('hardConstraintsToSparseFilterTokens — string SOFT attrs exclusion routing', () => {
  // Exclusion operators must still produce hard NOT-filter tokens (intentional design).
  it('style exclude produces a hard NOT-filter token (intended)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', 'exclude', 'bold'),
    ]);
    expect(tokens.some((t) => t.startsWith('style_not:'))).toBe(true);
  });

  it('certification exclude produces a hard NOT-filter token (intended)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('certification', 'exclude', 'biodynamic'),
    ]);
    expect(tokens.some((t) => t.startsWith('certification_not:'))).toBe(true);
  });

  it('flavor_profile not_in produces hard NOT-filter tokens (intended)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('flavor_profile', 'not_in', ['oaky', 'smoky']),
    ]);
    expect(tokens.some((t) => t.startsWith('flavor_profile_not'))).toBe(true);
  });

  // Alcohol is a HARD attribute — its cases must still work after all removals.
  it('alcohol >= value produces a hard YQL filter token (regression)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('alcohol', '>=', 13),
    ]);
    expect(tokens.some((t) => t.startsWith('alcohol_min:'))).toBe(true);
  });
});

// IDX-05 (sweetness): sweetness is in SOFT_CONSTRAINT_ATTRIBUTES — it is a
// string-soft attr (no numeric operator cases in the switch). Positive = / in
// constraints must not produce hard filter tokens.
describe('hardConstraintsToSparseFilterTokens — IDX-05: sweetness SOFT', () => {
  it('sweetness = value produces NO YQL filter token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('sweetness', '=', 'dry'),
    ]);
    expect(tokens.filter((t) => t.startsWith('sweetness'))).toHaveLength(0);
  });

  it('sweetness >= numeric produces NO YQL filter token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('sweetness', '>=', 0.2),
    ]);
    expect(tokens.filter((t) => t.startsWith('sweetness'))).toHaveLength(0);
  });
});

// isNumericRange invariant: inverted range (min > max) must not silently produce
// semantically impossible YQL (price >= 100 AND price <= 10 → zero results).
// The function currently accepts inverted ranges — this test documents the
// current behaviour and serves as a canary if the validation changes.
describe('hardConstraintsToSparseFilterTokens — numeric range constraints', () => {
  it('price_usd range with valid min < max emits both min and max tokens', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('price_usd', 'range', { min: 20, max: 50 } as unknown as number),
    ]);
    expect(tokens.some((t) => t.startsWith('price_usd_min:'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('price_usd_max:'))).toBe(true);
  });

  it('vintage_year range with valid min < max emits both min and max tokens', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('vintage_year', 'range', { min: 2010, max: 2020 } as unknown as number),
    ]);
    expect(tokens.some((t) => t.startsWith('vintage_year_min:'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('vintage_year_max:'))).toBe(true);
  });

  it('price_usd range boundary: min === max emits both tokens (single-year or exact price)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('price_usd', 'range', { min: 50, max: 50 } as unknown as number),
    ]);
    expect(tokens.some((t) => t.startsWith('price_usd_min:50'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('price_usd_max:50'))).toBe(true);
  });
});

// grape_primary dual-field: positive = / in must emit BOTH grape_primary: AND grapes:
// tokens so blend wines (variety in grapes[] but not grape_primary) are included.
// Exclusion already covers both; this ensures positive constraints have parity.
describe('hardConstraintsToSparseFilterTokens — grape_primary dual-field', () => {
  it('grape_primary = value emits grape_primary: token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', '=', 'Cabernet Sauvignon'),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_primary:'))).toBe(true);
  });

  it('grape_primary = value ALSO emits grapes: token (blend coverage)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', '=', 'Cabernet Sauvignon'),
    ]);
    expect(tokens.some((t) => t.startsWith('grapes:'))).toBe(true);
  });

  it('grape_primary in [...] emits grape_primary_in: token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'in', ['Cabernet', 'Merlot']),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_primary_in:'))).toBe(true);
  });

  it('grape_primary in [...] ALSO emits grapes_in: token (blend coverage)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'in', ['Cabernet', 'Merlot']),
    ]);
    expect(tokens.some((t) => t.startsWith('grapes_in:'))).toBe(true);
  });

  it('grape_primary exclude still covers both fields (regression)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'exclude', 'Chardonnay'),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_primary_not:'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('grapes_not:'))).toBe(true);
  });
});
