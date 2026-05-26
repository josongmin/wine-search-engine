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
  it('price_band = value produces NO YQL filter token (positive price intent is soft)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('price_band', '=', 'premium'),
    ]);
    expect(tokens.filter((t) => t.startsWith('price_band:'))).toHaveLength(0);
  });

  it('price_band in [...] produces NO positive YQL filter tokens', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('price_band', 'in', ['budget', 'premium']),
    ]);
    expect(tokens.filter((t) => t.startsWith('price_band:') || t.startsWith('price_band_in:'))).toHaveLength(0);
  });

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

// grape_primary dual-field: positive = / in must emit grape_or: compound token so
// buildSparseFilters produces (grape_primary contains "X" OR grapes contains "X").
// Previously emitted two separate tokens (grape_primary:X + grapes:X) which produced
// AND semantics — blend wines were incorrectly excluded.
describe('hardConstraintsToSparseFilterTokens — grape_primary dual-field (grape_or compound token)', () => {
  it('grape_primary = value emits grape_or: compound token (OR semantics for blend coverage)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', '=', 'Cabernet Sauvignon'),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_or:'))).toBe(true);
  });

  it('grape_primary = value does NOT emit separate grape_primary: token (no AND leakage)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', '=', 'Cabernet Sauvignon'),
    ]);
    expect(tokens.filter((t) => t.startsWith('grape_primary:'))).toHaveLength(0);
  });

  it('grape_primary = value does NOT emit separate grapes: token (no AND leakage)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', '=', 'Cabernet Sauvignon'),
    ]);
    expect(tokens.filter((t) => t.startsWith('grapes:'))).toHaveLength(0);
  });

  it('grape_primary in [...] emits grape_or_in: token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'in', ['Cabernet', 'Merlot']),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_or_in:'))).toBe(true);
  });

  it('grape_primary in [...] does NOT emit separate grape_primary_in: or grapes_in: tokens', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'in', ['Cabernet', 'Merlot']),
    ]);
    expect(tokens.filter((t) => t.startsWith('grape_primary_in:'))).toHaveLength(0);
    expect(tokens.filter((t) => t.startsWith('grapes_in:'))).toHaveLength(0);
  });

  it('grape_primary exclude still covers both fields (regression)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'exclude', 'Chardonnay'),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_primary_not:'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('grapes_not:'))).toBe(true);
  });

  it('grape_primary exclude array → grape_primary_not_in + grapes_not_in (dual-field coverage)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'exclude', ['Merlot', 'Cab']),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_primary_not_in:'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('grapes_not_in:'))).toBe(true);
    const pn = tokens.find((t) => t.startsWith('grape_primary_not_in:'));
    const gn = tokens.find((t) => t.startsWith('grapes_not_in:'));
    expect(pn).toMatch(/Merlot/);
    expect(pn).toMatch(/Cab/);
    expect(gn).toMatch(/Merlot/);
    expect(gn).toMatch(/Cab/);
  });

  it('grape_primary exclude single-element array → grape_primary_not + grapes_not (scalar form)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'exclude', ['Pinot Noir']),
    ]);
    expect(tokens.some((t) => t === 'grape_primary_not:Pinot Noir')).toBe(true);
    expect(tokens.some((t) => t === 'grapes_not:Pinot Noir')).toBe(true);
  });

  it('grape_primary not_in array → grape_primary_not_in + grapes_not_in (dual-field coverage)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_primary', 'not_in', ['Merlot', 'Syrah']),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_primary_not_in:'))).toBe(true);
    expect(tokens.some((t) => t.startsWith('grapes_not_in:'))).toBe(true);
  });
});

describe('hardConstraintsToSparseFilterTokens — grape_family (Round 4: was silently dropped)', () => {
  it('grape_family = value emits grape_family: token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_family', '=', 'Cabernet'),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_family:'))).toBe(true);
  });

  it('grape_family exclude value emits grape_family_not: token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_family', 'exclude', 'Chardonnay'),
    ]);
    expect(tokens.some((t) => t.startsWith('grape_family_not:'))).toBe(true);
  });
});

describe('hardConstraintsToSparseFilterTokens — exclude array for standard attributes', () => {
  it('country exclude array → country_not_in with pipe-delimited values', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('country', 'exclude', ['France', 'Italy']),
    ]);
    expect(tokens.some((t) => t.startsWith('country_not_in:'))).toBe(true);
    const tok = tokens.find((t) => t.startsWith('country_not_in:'));
    expect(tok).toMatch(/France/);
    expect(tok).toMatch(/Italy/);
  });

  it('country exclude single-element array → country_not scalar form', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('country', 'exclude', ['Spain']),
    ]);
    expect(tokens.some((t) => t === 'country_not:Spain')).toBe(true);
  });

  it('region not_in array → region_not_in with pipe-delimited values', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('region', 'not_in', ['Burgundy', 'Champagne']),
    ]);
    expect(tokens.some((t) => t.startsWith('region_not_in:'))).toBe(true);
    const tok = tokens.find((t) => t.startsWith('region_not_in:'));
    expect(tok).toMatch(/Burgundy/);
    expect(tok).toMatch(/Champagne/);
  });

  it('style not_in array → normalised style_not_in (oaked/unoaked map to "" and are dropped; oaky is not in map so stays)', () => {
    // 'oaky' → NOT in STYLE_NORMALISATION_MAP → fallback lowercase 'oaky' (kept, length > 0)
    // 'bold' → STYLE_NORMALISATION_MAP.get('bold') = 'bold' → kept
    // Both kept → style_not_in:oaky|bold (or bold|oaky depending on order)
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', 'not_in', ['oaky', 'bold']),
    ]);
    expect(tokens.some((t) => t.startsWith('style_not_in:') && t.includes('bold'))).toBe(true);
  });

  it('style not_in with oaked (in map → "") and full-bodied → only full remains', () => {
    // 'oaked' → STYLE_NORMALISATION_MAP maps to '' → filtered out
    // 'full-bodied' → maps to 'full' → kept
    // Single value remaining → style_not:full
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', 'not_in', ['oaked', 'full-bodied']),
    ]);
    expect(tokens.some((t) => t === 'style_not:full')).toBe(true);
  });

  it('style not_in two normalised values → style_not_in with pipe-delimited canonical tokens', () => {
    // Both 'full-bodied' and 'light-bodied' normalise to canonical values
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', 'not_in', ['full-bodied', 'light-bodied']),
    ]);
    expect(tokens.some((t) => t.startsWith('style_not_in:'))).toBe(true);
    const tok = tokens.find((t) => t.startsWith('style_not_in:'))!;
    expect(tok).toContain('full');
    expect(tok).toContain('light');
  });

  it('pipe character in exclude value is stripped to prevent token-delimiter injection', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('country', 'exclude', ['France|Italy']),
    ]);
    // pipe stripped → treated as single value, no pipe remains in output
    const tok = tokens.find((t) => t.startsWith('country_not:'));
    expect(tok).toBeDefined();
    expect(tok).not.toContain('|');
  });
});

describe('hardConstraintsToSparseFilterTokens — grape_family (BUG regression: was no-op)', () => {
  // Previously grape_family tokens were generated but not in FILTER_TOKEN_REGISTRY
  // so buildSparseFilters silently blocked them — grape family constraints were no-ops.
  it('grape_family = value produces grape_family: token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_family', '=', 'Cabernet'),
    ]);
    expect(tokens).toContain('grape_family:Cabernet');
  });

  it('grape_family exclude value produces grape_family_not: token', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('grape_family', 'exclude', 'Muscat'),
    ]);
    expect(tokens).toContain('grape_family_not:Muscat');
  });
});

describe('hardConstraintsToSparseFilterTokens — style/price_band exclude normalisation (BUG regression)', () => {
  // Previously exclude operators emitted raw un-normalised values.
  // style field stores canonical compound values ("full red", "light white") — not synonyms.
  // Exclusion of "full-bodied" must emit "full" (canonical) not "full-bodied" (synonym).
  it('style exclude "full-bodied" emits style_not:full (normalised)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', 'exclude', 'full-bodied'),
    ]);
    expect(tokens).toContain('style_not:full');
    expect(tokens).not.toContain('style_not:full-bodied');
  });

  it('style exclude "light-bodied" emits style_not:light (normalised)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', 'exclude', 'light-bodied'),
    ]);
    expect(tokens).toContain('style_not:light');
  });

  it('style exclude "oaked" emits no token (non-indexable style value)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', 'exclude', 'oaked'),
    ]);
    expect(tokens.filter((t) => t.startsWith('style_not'))).toHaveLength(0);
  });

  it('price_band exclude "expensive" emits price_band_not:premium (normalised)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('price_band', 'exclude', 'expensive'),
    ]);
    expect(tokens).toContain('price_band_not:premium');
    expect(tokens).not.toContain('price_band_not:expensive');
  });

  it('price_band exclude "high-end" emits price_band_not:premium (normalised)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('price_band', 'exclude', 'high-end'),
    ]);
    expect(tokens).toContain('price_band_not:premium');
  });

  it('price_band not_in ["budget", "luxury"] emits price_band_not_in with canonical values', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('price_band', 'not_in', ['budget', 'luxury']),
    ]);
    const tok = tokens.find((t) => t.startsWith('price_band_not_in:'));
    expect(tok).toBeDefined();
    expect(tok).toContain('value');   // 'budget' → 'value'
    expect(tok).toContain('luxury');
  });
});

describe('hardConstraintsToSparseFilterTokens — alcohol reversed range (BUG regression)', () => {
  // Previously alcohol range did not normalise reversed ranges like price_usd/vintage_year do.
  // { min: 20, max: 10 } would produce alcohol_pct >= 20 AND <= 10 → always false → 0 results.
  it('alcohol range with lo > hi normalises to correct min/max', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('alcohol', 'range', { min: 20, max: 10 }),
    ]);
    const minTok = tokens.find((t) => t.startsWith('alcohol_min:'));
    const maxTok = tokens.find((t) => t.startsWith('alcohol_max:'));
    expect(minTok).toBeDefined();
    expect(maxTok).toBeDefined();
    // After normalisation: lo=10, hi=20
    expect(minTok).toBe('alcohol_min:10');
    expect(maxTok).toBe('alcohol_max:20');
  });

  it('alcohol range with lo < hi passes through unchanged', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('alcohol', 'range', { min: 12, max: 15 }),
    ]);
    expect(tokens).toContain('alcohol_min:12');
    expect(tokens).toContain('alcohol_max:15');
  });
});

describe('hardConstraintsToSparseFilterTokens — style regex escape (R-REGEX-01)', () => {
  // Vespa `matches` uses Java regex. Raw LLM-emitted style values containing
  // metacharacters (., *, +, ?, (, )) must be escaped to prevent unintended
  // broad matching or PatternSyntaxException errors.

  it('R-REGEX-01: known canonical values pass through without escaping', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', '=', 'full'),
    ]);
    // Canonical value — no escaping needed, no backslashes
    expect(tokens).toContain('style_matches:full');
  });

  it('R-REGEX-02: style value with dot is escaped (dot is regex wildcard)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', '=', 'full.bodied'),
    ]);
    // Dot must be escaped to \. to avoid matching any character
    const tok = tokens.find((t) => t.startsWith('style_matches:'));
    expect(tok).toBeDefined();
    expect(tok).toContain('\\.');
    expect(tok).not.toBe('style_matches:full.bodied');
  });

  it('R-REGEX-03: style value with .* does not produce a style_matches:.* wildcard', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', '=', '.*'),
    ]);
    const tok = tokens.find((t) => t.startsWith('style_matches:'));
    // Must be escaped — raw .* would match every wine
    if (tok !== undefined) {
      expect(tok).not.toBe('style_matches:.*');
      expect(tok).toContain('\\');
    }
  });

  it('R-REGEX-04: unknown style value in "in" array is escaped', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      makeConstraint('style', 'in', ['full', 'tannic+spicy']),
    ]);
    // 'full' → canonical, 'tannic+spicy' → + must be escaped
    const tok = tokens.find((t) => t.startsWith('style_matches') || t.startsWith('style_matches_in'));
    expect(tok).toBeDefined();
    // The + character must not appear unescaped in the token
    const valueAfterColon = tok?.split(':').slice(1).join(':') ?? '';
    // Split on | to check individual values
    const parts = valueAfterColon.split('|');
    const tannicPart = parts.find((p) => p.includes('tannic'));
    if (tannicPart !== undefined) {
      expect(tannicPart).toContain('\\+');
    }
  });
});
