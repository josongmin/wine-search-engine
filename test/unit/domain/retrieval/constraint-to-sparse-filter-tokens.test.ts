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

  it('maps pairing and occasion as filter tokens', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'pairing', operator: '=', value: 'beef' }),
      c({ attribute: 'occasion', operator: 'in', value: ['gift', 'celebration'] }),
    ]);
    expect(tokens).toEqual([
      'pairing_in:beef|steak|wagyu beef|braised beef',
      'occasion_in:gift|celebration',
    ]);
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

  // --- style normalisation (REGRESSION: style field uses attribute-only indexing,
  //     must use `style_matches:` token for `matches` regex, NOT `style:` for `contains`) ---

  it('style "light" → style_matches:light (not style:light — attribute-only field requires matches operator)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: '=', value: 'light' }),
    ]);
    expect(tokens).toEqual(['style_matches:light']);
  });

  it('style "light-bodied" → style_matches:light (synonym normalisation)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: '=', value: 'light-bodied' }),
    ]);
    expect(tokens).toEqual(['style_matches:light']);
  });

  it('style "medium bodied" → style_matches:medium', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: '=', value: 'medium bodied' }),
    ]);
    expect(tokens).toEqual(['style_matches:medium']);
  });

  it('style "full-bodied" → style_matches:full', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: '=', value: 'full-bodied' }),
    ]);
    expect(tokens).toEqual(['style_matches:full']);
  });

  it('style "bold" → style_matches:bold', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: '=', value: 'bold' }),
    ]);
    expect(tokens).toEqual(['style_matches:bold']);
  });

  it('style "heavy" → style_matches:bold (synonym)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: '=', value: 'heavy' }),
    ]);
    expect(tokens).toEqual(['style_matches:bold']);
  });

  it('style "oaked" → [] (non-indexable value — no Vespa enum match)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: '=', value: 'oaked' }),
    ]);
    expect(tokens).toEqual([]);
  });

  it('style exclusion operator → uses stringEq path (style_not:, not style_matches_not:)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'exclude', value: 'bold' }),
    ]);
    expect(tokens).toEqual(['style_not:bold']);
  });

  it('style not_in → uses stringEq path', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'not_in', value: ['bold', 'full'] }),
    ]);
    expect(tokens).toEqual(['style_not_in:bold|full']);
  });

  it('style operator=in with array → emits pipe-delimited style_matches_in token (not silent drop)', () => {
    // REGRESSION BUG FIX: before fix, `operator === 'in'` + array value was silently dropped
    // because the condition also required `typeof value === 'string'` — always false for arrays.
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'in', value: ['light', 'medium'] }),
    ]);
    expect(tokens).toEqual(['style_matches_in:light|medium']);
  });

  it('style operator=in with single array value → emits style_matches: (no _in)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'in', value: ['bold'] }),
    ]);
    expect(tokens).toEqual(['style_matches:bold']);
  });

  it('style operator=in normalises synonyms in each array value', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'in', value: ['heavy', 'full-bodied'] }),
    ]);
    // heavy → bold, full-bodied → full
    expect(tokens).toEqual(['style_matches_in:bold|full']);
  });

  it('style operator=in drops non-indexable values (oaked) from array', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'in', value: ['oaked', 'light'] }),
    ]);
    // oaked normalises to "" → dropped; only light survives
    expect(tokens).toEqual(['style_matches:light']);
  });

  it('style operator=in with all non-indexable values → empty (not crash)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'in', value: ['oaked', 'unoaked'] }),
    ]);
    expect(tokens).toEqual([]);
  });

  // --- price_band: positive operators are deliberately NOT hard-filter tokens.
  // Per the canonicalize-search-contract commit (211aa1de): positive
  // price-band intent is candidate-shaping / bounded lexical expansion, not a
  // hard retrieval filter — a user saying "give me an affordable wine" should
  // shape ranking, not strictly prune the corpus. Only exclusion operators
  // produce hard NOT-filters from this emitter. See `case 'price_band'` in
  // constraint-to-sparse-filter-tokens.ts.

  it('price_band "=" returns [] — deferred to candidate-shaping path', () => {
    for (const synonym of ['budget', 'affordable', 'cheap', 'mid-range', 'high-end', 'fine', 'premium']) {
      const tokens = hardConstraintsToSparseFilterTokens([
        c({ attribute: 'price_band', operator: '=', value: synonym }),
      ]);
      expect(tokens).toEqual([]);
    }
  });

  it('price_band "in" returns [] — deferred to candidate-shaping path', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'price_band', operator: 'in', value: ['budget', 'premium'] }),
    ]);
    expect(tokens).toEqual([]);
  });

  it('price_band exclusion → uses stringEq path (price_band_not:) with synonym normalisation', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'price_band', operator: 'exclude', value: 'luxury' }),
    ]);
    expect(tokens).toEqual(['price_band_not:luxury']);
  });

  it('price_band not_in with array → stringEq path', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'price_band', operator: 'not_in', value: ['value', 'mid'] }),
    ]);
    expect(tokens).toEqual(['price_band_not_in:value|mid']);
  });
});

// ---------------------------------------------------------------------------
// Full attribute × operator matrix — ensures no silent drops when adding
// new attributes or modifying the stringEq helper
// ---------------------------------------------------------------------------
describe('hardConstraintsToSparseFilterTokens — attribute × operator matrix', () => {
  // region
  it('region = → region:Napa', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'region', operator: '=', value: 'Napa' })])).toEqual(['region:Napa']);
  });
  it('region in → region_in:Napa|Sonoma', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'region', operator: 'in', value: ['Napa', 'Sonoma'] })])).toEqual(['region_in:Napa|Sonoma']);
  });
  it('region exclude → region_not:Napa', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'region', operator: 'exclude', value: 'Napa' })])).toEqual(['region_not:Napa']);
  });
  it('region not_in → region_not_in:Napa|Sonoma', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'region', operator: 'not_in', value: ['Napa', 'Sonoma'] })])).toEqual(['region_not_in:Napa|Sonoma']);
  });

  // appellation
  it('appellation = → appellation:Pomerol', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'appellation', operator: '=', value: 'Pomerol' })])).toEqual(['appellation:Pomerol']);
  });
  it('appellation in → appellation_in:Pomerol|Margaux', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'appellation', operator: 'in', value: ['Pomerol', 'Margaux'] })])).toEqual(['appellation_in:Pomerol|Margaux']);
  });
  it('appellation exclude → appellation_not:Pomerol', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'appellation', operator: 'exclude', value: 'Pomerol' })])).toEqual(['appellation_not:Pomerol']);
  });
  it('appellation not_in → appellation_not_in:Pomerol|Margaux', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'appellation', operator: 'not_in', value: ['Pomerol', 'Margaux'] })])).toEqual(['appellation_not_in:Pomerol|Margaux']);
  });

  // classification
  it('classification = → classification:premier_cru', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'classification', operator: '=', value: 'premier_cru' })])).toEqual(['classification:premier_cru']);
  });
  it('classification in → classification_in:premier_cru|grand_cru', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'classification', operator: 'in', value: ['premier_cru', 'grand_cru'] })])).toEqual(['classification_in:premier_cru|grand_cru']);
  });
  it('classification exclude → classification_not:grand_cru', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'classification', operator: 'exclude', value: 'grand_cru' })])).toEqual(['classification_not:grand_cru']);
  });
  it('classification not_in single → classification_not:premier_cru', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'classification', operator: 'not_in', value: ['premier_cru'] })])).toEqual(['classification_not:premier_cru']);
  });
  it('classification not_in multi → classification_not_in:premier_cru|grand_cru', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'classification', operator: 'not_in', value: ['premier_cru', 'grand_cru'] })])).toEqual(['classification_not_in:premier_cru|grand_cru']);
  });

  // certification
  it('certification = → certification:organic', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'certification', operator: '=', value: 'organic' })])).toEqual(['certification:organic']);
  });
  it('certification in → certification_in:organic|biodynamic', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'certification', operator: 'in', value: ['organic', 'biodynamic'] })])).toEqual(['certification_in:organic|biodynamic']);
  });
  it('certification exclude → certification_not:organic', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'certification', operator: 'exclude', value: 'organic' })])).toEqual(['certification_not:organic']);
  });
  it('certification not_in → certification_not_in:organic|vegan', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'certification', operator: 'not_in', value: ['organic', 'vegan'] })])).toEqual(['certification_not_in:organic|vegan']);
  });

  // flavor_profile
  it('flavor_profile = → flavor_profile:fruity', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'flavor_profile', operator: '=', value: 'fruity' })])).toEqual(['flavor_profile:fruity']);
  });
  it('flavor_profile in → flavor_profile_in:fruity|floral', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'flavor_profile', operator: 'in', value: ['fruity', 'floral'] })])).toEqual(['flavor_profile_in:fruity|floral']);
  });
  it('flavor_profile exclude → flavor_profile_not:oaky', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'flavor_profile', operator: 'exclude', value: 'oaky' })])).toEqual(['flavor_profile_not:oaky']);
  });
  it('flavor_profile not_in → flavor_profile_not_in:oaky|mineral', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'flavor_profile', operator: 'not_in', value: ['oaky', 'mineral'] })])).toEqual(['flavor_profile_not_in:oaky|mineral']);
  });

  // soil_type
  it('soil_type = → soil_type:clay', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'soil_type', operator: '=', value: 'clay' })])).toEqual(['soil_type:clay']);
  });
  it('soil_type in → soil_type_in:clay|limestone', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'soil_type', operator: 'in', value: ['clay', 'limestone'] })])).toEqual(['soil_type_in:clay|limestone']);
  });
  it('soil_type exclude → soil_type_not:clay', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'soil_type', operator: 'exclude', value: 'clay' })])).toEqual(['soil_type_not:clay']);
  });
  it('soil_type not_in → soil_type_not_in:clay|loam', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'soil_type', operator: 'not_in', value: ['clay', 'loam'] })])).toEqual(['soil_type_not_in:clay|loam']);
  });

  // producer_type
  it('producer_type = → producer_type:estate', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'producer_type', operator: '=', value: 'estate' })])).toEqual(['producer_type:estate']);
  });
  it('producer_type in → producer_type_in:estate|negociant', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'producer_type', operator: 'in', value: ['estate', 'negociant'] })])).toEqual(['producer_type_in:estate|negociant']);
  });
  it('producer_type exclude → producer_type_not:cooperative', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'producer_type', operator: 'exclude', value: 'cooperative' })])).toEqual(['producer_type_not:cooperative']);
  });
  it('producer_type not_in → producer_type_not_in:cooperative|importer', () => {
    expect(hardConstraintsToSparseFilterTokens([c({ attribute: 'producer_type', operator: 'not_in', value: ['cooperative', 'importer'] })])).toEqual(['producer_type_not_in:cooperative|importer']);
  });
});

// ---------------------------------------------------------------------------
// Pipe injection defense — | in constraint values must be stripped before
// being used as token delimiters
// ---------------------------------------------------------------------------
describe('hardConstraintsToSparseFilterTokens — pipe injection defense', () => {
  it('strips | from single string value (= operator)', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'country', operator: '=', value: 'France|Italy' }),
    ]);
    // pipe stripped → "FranceItaly" as single token
    expect(tokens).toEqual(['country:FranceItaly']);
  });

  it('strips | from each value in in-array constraint', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'country', operator: 'in', value: ['Fr|ance', 'It|aly'] }),
    ]);
    expect(tokens).toEqual(['country_in:France|Italy']);
  });

  it('strips | from exclude constraint value', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'region', operator: 'exclude', value: 'Napa|Sonoma' }),
    ]);
    expect(tokens).toEqual(['region_not:NapaSonoma']);
  });

  it('strips | from not_in array values', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'appellation', operator: 'not_in', value: ['Pome|rol', 'Margaux'] }),
    ]);
    expect(tokens).toEqual(['appellation_not_in:Pomerol|Margaux']);
  });

  it('drops values that collapse to empty after pipe stripping', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'country', operator: 'in', value: ['|', 'France'] }),
    ]);
    // "|" → stripped to "" → filtered; only France remains → single-value path
    expect(tokens).toEqual(['country:France']);
  });

  it('strips | from grape_primary exclude — both dual-field tokens', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'grape_primary', operator: 'exclude', value: 'Merlot|Cab' }),
    ]);
    expect(tokens).toContain('grape_primary_not:MerlotCab');
    expect(tokens).toContain('grapes_not:MerlotCab');
  });

  it('strips | from style not_in values', () => {
    const tokens = hardConstraintsToSparseFilterTokens([
      c({ attribute: 'style', operator: 'not_in', value: ['bold|red', 'light'] }),
    ]);
    expect(tokens).toEqual(['style_not_in:boldred|light']);
  });
});
