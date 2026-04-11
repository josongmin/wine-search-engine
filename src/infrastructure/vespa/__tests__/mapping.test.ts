import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import {
  fromVespaFields,
  readRawVespaRetrievalSummary,
  toVespaFields,
  buildSparseFilters,
  toRetrievalFeatureProjection,
} from '../mapping.js';

function makeDocument(overrides: Partial<RetrievalDocument> = {}): RetrievalDocument {
  return {
    entityId: createEntityId('vespa-mapping-test'),
    entityType: 'wine',
    canonicalLabel: 'Mapping Wine',
    aliasesIdentitySafe: ['Mapping Wine'],
    aliasesNoisyRecall: ['Mapping'],
    producer: 'Mapping Producer',
    region: 'Barolo',
    grapes: ['Nebbiolo'],
    searchTextKo: '매핑 와인',
    searchTextEn: 'Mapping wine search text',
    semanticSummary: 'Mapping wine semantic summary',
    body: 0.8,
    sweetness: 0.1,
    style: 'structured red',
    priceBand: 'luxury',
    pairing: ['braised beef', ' aged cheese '],
    occasion: [' celebration ', 'cellaring'],
    availability: true,
    popularityScore: 0.92,
    vintageYear: 2019,
    acidity: 0.6,
    tannin: 0.7,
    finishLength: 0.9,
    wineType: 'red',
    grapePrimary: 'Nebbiolo',
    country: 'Italy',
    appellation: 'Barolo DOCG',
    producerPrestige: 0.95,
    criticScoreNormalized: 0.97,
    priceUsd: 240,
    flavorProfiles: ['rose', 'tar'],
    classification: 'DOCG',
    alcoholPct: 14.5,
    drinkingWindowStart: 2027,
    drinkingWindowEnd: 2042,
    drinkingWindowModelVersion: 'dw-v5',
    oakTreatment: 'large oak cask',
    certifications: [' organic ', 'biodynamic'],
    soilType: 'limestone',
    producerType: 'domaine',
    ...overrides,
  };
}

describe('fromVespaFields entity_id validation', () => {
  it('throws a descriptive error when entity_id is missing from Vespa response', () => {
    // Previously, fromVespaFields called createEntityId(getString(fields, 'entity_id'))
    // which would invoke createEntityId('') and throw a cryptic
    // "EntityId cannot be an empty string" error with no context about
    // which document or which fields were present.
    expect(() =>
      fromVespaFields({
        canonical_label: 'Some Wine',
        producer: 'Some Producer',
        // entity_id deliberately absent
      }),
    ).toThrow(/malformed Vespa document/);
  });

  it('throws a descriptive error when entity_id is not a string', () => {
    expect(() =>
      fromVespaFields({
        entity_id: 12345, // number instead of string
        canonical_label: 'Some Wine',
      }),
    ).toThrow(/malformed Vespa document/);
  });

  it('error message does NOT include available field keys (schema disclosure protection)', () => {
    // L15 hardening: error messages must not leak internal field keys
    // because they propagate to clients via 500 responses. Operators get
    // the full key list from structured logs, not from the exception text.
    let message = '';
    try {
      fromVespaFields({ canonical_label: 'Wine', vintage_year: 2019 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('canonical_label');
    expect(message).not.toContain('vintage_year');
    expect(message).toMatch(/malformed Vespa document/);
  });
});

describe('vespa mapping retrieval summary SSOT', () => {
  it('writes and reads retrieval summary fields through the shared Vespa mapping contract', () => {
    const doc = makeDocument();

    const fields = toVespaFields(doc);
    expect(fields).toMatchObject({
      canonical_label: 'Mapping Wine',
      producer: 'Mapping Producer',
      region: 'Barolo',
      search_text_en: 'Mapping wine search text',
      grape_primary: 'Nebbiolo',
      price_band: 'luxury',
      pairing: ['braised beef', ' aged cheese '],
      occasion: [' celebration ', 'cellaring'],
      producer_prestige: 0.95,
      drinking_window_model_version: 'dw-v5',
      certifications: [' organic ', 'biodynamic'],
      soil_type: 'limestone',
      producer_type: 'domaine',
    });

    expect(readRawVespaRetrievalSummary(fields)).toMatchObject({
      canonicalLabel: 'Mapping Wine',
      producer: 'Mapping Producer',
      region: 'Barolo',
      searchTextEn: 'Mapping wine search text',
      grapePrimary: 'Nebbiolo',
      priceBand: 'luxury',
      pairing: ['braised beef', ' aged cheese '],
      occasion: [' celebration ', 'cellaring'],
      producerPrestige: 0.95,
      drinkingWindowModelVersion: 'dw-v5',
      certifications: [' organic ', 'biodynamic'],
      soilType: 'limestone',
      producerType: 'domaine',
    });

    const roundTripped = fromVespaFields(fields);
    expect(roundTripped).toMatchObject({
      entityId: doc.entityId,
      canonicalLabel: doc.canonicalLabel,
      producer: doc.producer,
      region: doc.region,
      searchTextEn: doc.searchTextEn,
      pairing: doc.pairing,
      occasion: doc.occasion,
      producerPrestige: doc.producerPrestige,
      drinkingWindowModelVersion: doc.drinkingWindowModelVersion,
      certifications: doc.certifications,
      soilType: doc.soilType,
      producerType: doc.producerType,
    });
  });

  it('omits absent optional summary fields while preserving required retrieval document fields', () => {
    const fields = toVespaFields(makeDocument({
      grapePrimary: undefined,
      producerPrestige: undefined,
      drinkingWindowModelVersion: undefined,
      certifications: undefined,
      soilType: undefined,
      producerType: undefined,
    }));

    expect(fields).not.toHaveProperty('grape_primary');
    expect(fields).not.toHaveProperty('producer_prestige');
    expect(fields).not.toHaveProperty('drinking_window_model_version');
    expect(fields).not.toHaveProperty('certifications');
    expect(fields).not.toHaveProperty('soil_type');
    expect(fields).not.toHaveProperty('producer_type');

    const roundTripped = fromVespaFields(fields);
    expect(roundTripped.canonicalLabel).toBe('Mapping Wine');
    expect(roundTripped.searchTextEn).toBe('Mapping wine search text');
    expect(roundTripped.grapePrimary).toBeUndefined();
    expect(roundTripped.producerPrestige).toBeUndefined();
    expect(roundTripped.drinkingWindowModelVersion).toBeUndefined();
    expect(roundTripped.certifications).toBeUndefined();
    expect(roundTripped.soilType).toBeUndefined();
    expect(roundTripped.producerType).toBeUndefined();
  });
});

// E1-P3-7: body/sweetness null vs 0 distinction
describe('fromVespaFields — body/sweetness null vs 0 (E1-P3-7)', () => {
  it('body=0 in Vespa → field is present with value 0 in returned document', () => {
    const doc = fromVespaFields({
      entity_id: 'test-wine',
      entity_type: 'wine',
      body: 0,
    });
    // body=0 is a legitimate "no body" value — must be preserved, not treated as absent
    expect('body' in doc).toBe(true);
    expect(doc.body).toBe(0);
  });

  it('sweetness=0 in Vespa → field is present with value 0 in returned document', () => {
    const doc = fromVespaFields({
      entity_id: 'test-wine',
      entity_type: 'wine',
      sweetness: 0,
    });
    expect('sweetness' in doc).toBe(true);
    expect(doc.sweetness).toBe(0);
  });

  it('body absent from Vespa → field is absent (undefined) in returned document', () => {
    const doc = fromVespaFields({
      entity_id: 'test-wine',
      entity_type: 'wine',
      // body field intentionally absent
    });
    // "no data" → omit key entirely, not body: 0
    expect(doc.body).toBeUndefined();
  });

  it('sweetness absent from Vespa → field is absent (undefined) in returned document', () => {
    const doc = fromVespaFields({
      entity_id: 'test-wine',
      entity_type: 'wine',
      // sweetness field intentionally absent
    });
    expect(doc.sweetness).toBeUndefined();
  });

  it('body=0.5 (non-zero) round-trips correctly', () => {
    const doc = fromVespaFields({
      entity_id: 'test-wine',
      entity_type: 'wine',
      body: 0.5,
    });
    expect(doc.body).toBeCloseTo(0.5);
  });
});

// E1-P3-7 (regression): toRetrievalFeatureProjection body=0 / sweetness=0 must be preserved
describe('toRetrievalFeatureProjection — body/sweetness null vs 0 (E1-P3-7)', () => {
  it('body=0 on document → feature projection includes body:0 (was: silently dropped by !== 0)', () => {
    const doc = makeDocument({ body: 0 });
    const proj = toRetrievalFeatureProjection(doc);
    // body=0 is a valid [0,1] normalised value (fully light-bodied wine)
    expect('body' in proj).toBe(true);
    expect(proj.body).toBe(0);
  });

  it('sweetness=0 on document → feature projection includes sweetness:0 (was: silently dropped)', () => {
    const doc = makeDocument({ sweetness: 0 });
    const proj = toRetrievalFeatureProjection(doc);
    expect('sweetness' in proj).toBe(true);
    expect(proj.sweetness).toBe(0);
  });

  it('body absent (undefined) → feature projection omits body key', () => {
    const doc = makeDocument({ body: undefined });
    const proj = toRetrievalFeatureProjection(doc);
    expect(proj.body).toBeUndefined();
  });

  it('sweetness absent (undefined) → feature projection omits sweetness key', () => {
    const doc = makeDocument({ sweetness: undefined });
    const proj = toRetrievalFeatureProjection(doc);
    expect(proj.sweetness).toBeUndefined();
  });

  it('body=0.7 round-trips correctly', () => {
    const doc = makeDocument({ body: 0.7 });
    const proj = toRetrievalFeatureProjection(doc);
    expect(proj.body).toBeCloseTo(0.7);
  });

  it('tannin=0 is preserved (was: treated same as undefined by old !== 0 pattern)', () => {
    const doc = makeDocument({ tannin: 0 });
    const proj = toRetrievalFeatureProjection(doc);
    expect('tannin' in proj).toBe(true);
    expect(proj.tannin).toBe(0);
  });

  it('acidity=0 is preserved', () => {
    const doc = makeDocument({ acidity: 0 });
    const proj = toRetrievalFeatureProjection(doc);
    expect('acidity' in proj).toBe(true);
    expect(proj.acidity).toBe(0);
  });
});

// IDX-05 (extended): body, tannin, critic_score, producer_prestige, finish_length are SOFT —
// hardConstraintsToSparseFilterTokens must NOT generate hard YQL tokens for them.
// BUG-01: region positive filter drop
// constraint-to-sparse-filter-tokens.ts emits 'region:Burgundy' for single-value positive.
// mapping.ts switch had case 'region_not' and multi-value 'region_in' but
// NO case 'region' — single-value positive was silently dropped (default case no-op).
describe('buildSparseFilters — region filter (BUG-01)', () => {
  it('single-value positive region filter produces YQL contains clause', () => {
    const yql = buildSparseFilters(['region:Burgundy']);
    expect(yql).toContain('region contains "Burgundy"');
  });

  it('region negation filter still works', () => {
    const yql = buildSparseFilters(['region_not:Burgundy']);
    expect(yql).toContain('!(region contains "Burgundy")');
  });

  it('region multi-value IN filter works via ALLOWED_SPARSE_IN_FIELDS path', () => {
    const yql = buildSparseFilters(['region_in:Burgundy|Barolo']);
    expect(yql).toContain('region contains');
  });

  it('regression: country, wine_type, appellation positive filters still work', () => {
    expect(buildSparseFilters(['country:France'])).toContain('country contains "France"');
    expect(buildSparseFilters(['wine_type:red'])).toContain('wine_type contains "red"');
    expect(buildSparseFilters(['appellation:Pomerol'])).toContain('appellation contains "Pomerol"');
  });

  it('empty filter array returns empty string', () => {
    expect(buildSparseFilters([])).toBe('');
  });
});

// Bug-1: flavorProfiles double-write in toVespaFields / misread in fromVespaFields
//
// After adding flavorProfiles to VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS, the old explicit
// `fields['flavor_profiles'] = ...` line in toVespaFields was still present, causing a
// double-write. In fromVespaFields, the value was read from fields['flavor_profiles']
// directly instead of via summary.flavorProfiles, diverging from the spec registry SSoT.
describe('flavorProfiles Vespa mapping (Bug-1 regression)', () => {
  it('toVespaFields writes flavor_profiles exactly once via VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS', () => {
    const doc = makeDocument({ flavorProfiles: ['cherry', 'leather'] });
    const fields = toVespaFields(doc);

    // Confirm the field is written correctly.
    expect(fields['flavor_profiles']).toEqual(['cherry', 'leather']);

    // Enumerate all keys to confirm 'flavor_profiles' appears only once.
    const keys = Object.keys(fields);
    const flavorProfileKeys = keys.filter((k) => k === 'flavor_profiles');
    expect(flavorProfileKeys).toHaveLength(1);
  });

  it('fromVespaFields reads flavorProfiles via summary (VESPA_RETRIEVAL_SUMMARY_FIELD_SPECS SSoT)', () => {
    const doc = makeDocument({ flavorProfiles: ['plum', 'tobacco'] });
    const fields = toVespaFields(doc);

    const roundTripped = fromVespaFields(fields);
    expect(roundTripped.flavorProfiles).toEqual(['plum', 'tobacco']);
  });

  it('fromVespaFields returns undefined flavorProfiles when field is absent from Vespa response', () => {
    const doc = makeDocument({ flavorProfiles: undefined });
    const fields = toVespaFields(doc);

    // Confirm the field is absent (no double-write side-effect).
    expect(fields['flavor_profiles']).toBeUndefined();

    const roundTripped = fromVespaFields(fields);
    expect(roundTripped.flavorProfiles).toBeUndefined();
  });

  it('readRawVespaRetrievalSummary returns flavorProfiles via spec (not a manual read path)', () => {
    const fields = toVespaFields(makeDocument({ flavorProfiles: ['rose', 'violet'] }));
    const summary = readRawVespaRetrievalSummary(fields);
    expect(summary.flavorProfiles).toEqual(['rose', 'violet']);
  });
});
