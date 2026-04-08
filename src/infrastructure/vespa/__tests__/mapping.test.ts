import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import {
  fromVespaFields,
  readRawVespaRetrievalSummary,
  toVespaFields,
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
