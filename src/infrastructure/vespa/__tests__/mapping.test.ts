import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import {
  fromVespaFields,
  readRawVespaRetrievalSummary,
  toVespaFields,
  buildSparseFilters,
  toRetrievalFeatureProjection,
  parseHitSummary,
  toRetrievalHitProjection,
} from '../mapping.js';
import { SOURCE_SYSTEM_VIVINO_SILVER } from '../../../domain/shared/constants/source-systems.js';
import { stableJsonStringify } from '../../../domain/shared/utils/stable-json.js';

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
    ratingAvg: 4.6,
    ratingsCount: 1287,
    reviewCount: 211,
    ratingDistribution: { '1': 2, '2': 10, '3': 115, '4': 540, '5': 620 },
    wineryRatingCount: 8240,
    priceUsd: 240,
    bottleSizeMl: 750,
    bottleSize: '750ml',
    closure: 'Cork',
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

function makeMinimalRequiredFields(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    entity_id: 'test-wine',
    entity_type: 'wine',
    canonical_label: 'Some Wine',
    aliases_identity_safe: ['Some Wine'],
    aliases_noisy_recall: ['Some'],
    producer: 'Some Producer',
    region: 'Some Region',
    grapes: ['Cabernet Sauvignon'],
    search_text_ko: '어떤 와인',
    search_text_en: 'Some wine',
    semantic_summary: 'summary',
    price_band: 'mid',
    pairing: ['cheese'],
    availability: true,
    popularity_score: 0.5,
    style: 'red',
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

  it('defaults missing search_text_ko/en/semantic_summary to canonical label', () => {
    const doc = fromVespaFields({
      ...makeMinimalRequiredFields(),
      search_text_ko: undefined,
      search_text_en: undefined,
      semantic_summary: undefined,
    });
    expect(doc.searchTextKo).toBe('Some Wine');
    expect(doc.searchTextEn).toBe('Some Wine');
    expect(doc.semanticSummary).toBe('Some Wine');
  });

  it('falls back canonical label when search_text_ko/en/semantic_summary are empty strings', () => {
    const doc = fromVespaFields({
      ...makeMinimalRequiredFields({ 'canonical_label': 'Some Wine' }),
      search_text_ko: '',
      search_text_en: '',
      semantic_summary: '',
    });
    expect(doc.searchTextKo).toBe('Some Wine');
    expect(doc.searchTextEn).toBe('Some Wine');
    expect(doc.semanticSummary).toBe('Some Wine');
  });

  it('defaults missing identity aliases to an empty array for partial Vespa docs', () => {
    const doc = fromVespaFields({
      ...makeMinimalRequiredFields(),
      aliases_identity_safe: undefined,
      aliases_noisy_recall: undefined,
    });
    expect(doc.aliasesIdentitySafe).toEqual([]);
    expect(doc.aliasesNoisyRecall).toEqual([]);
  });

  it('throws when identity alias field exists but has invalid type', () => {
    expect(() =>
      fromVespaFields({
        ...makeMinimalRequiredFields(),
        aliases_identity_safe: 'not-an-array',
      } as unknown as Record<string, unknown>),
    ).toThrow(/malformed Vespa document/);
  });

  it('throws when noisy alias field exists but has invalid type', () => {
    expect(() =>
      fromVespaFields({
        ...makeMinimalRequiredFields(),
        aliases_identity_safe: ['good'],
        aliases_noisy_recall: 123,
      } as unknown as Record<string, unknown>),
    ).toThrow(/malformed Vespa document/);
  });

  it('defaults missing pairing to an empty array for partial Vespa docs', () => {
    const doc = fromVespaFields({
      ...makeMinimalRequiredFields(),
      pairing: undefined,
    });
    expect(doc.pairing).toEqual([]);
  });

  it('defaults missing grapes to an empty array for partial Vespa docs', () => {
    const doc = fromVespaFields({
      ...makeMinimalRequiredFields(),
      grapes: undefined,
    });
    expect(doc.grapes).toEqual([]);
  });

  it('throws when pairing field exists but has invalid type', () => {
    expect(() =>
      fromVespaFields({
        ...makeMinimalRequiredFields(),
        pairing: 'not-an-array',
      } as unknown as Record<string, unknown>),
    ).toThrow(/malformed Vespa document/);
  });

  it('throws when grapes field exists but has invalid type', () => {
    expect(() =>
      fromVespaFields({
        ...makeMinimalRequiredFields(),
        grapes: 'not-an-array',
      } as unknown as Record<string, unknown>),
    ).toThrow(/malformed Vespa document/);
  });

  it('accepts numeric-string Vespa fields and coerces them to numbers', () => {
    const doc = fromVespaFields({
      ...makeMinimalRequiredFields(),
      popularity_score: '0.5',
      critic_score_normalized: '0.82',
      price_usd: '82.0000',
      rating_avg: '4.10',
    });

    expect(doc.popularityScore).toBe(0.5);
    expect(doc.criticScoreNormalized).toBe(0.82);
    expect(doc.priceUsd).toBe(82);
    expect(doc.ratingAvg).toBe(4.1);
  });
});

describe('vespa mapping retrieval summary SSOT', () => {
  it('writes and reads retrieval summary fields through the shared Vespa mapping contract', () => {
    const doc = makeDocument({ searchSnapshotId: 'search-snapshot:v1:mapping-test' });

    const fields = toVespaFields(doc);
    expect(fields).toMatchObject({
      search_snapshot_id: 'search-snapshot:v1:mapping-test',
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
      rating_avg: 4.6,
      ratings_count: 1287,
      review_count: 211,
      rating_distribution_json: stableJsonStringify({ '1': 2, '2': 10, '3': 115, '4': 540, '5': 620 }),
      winery_rating_count: 8240,
      bottle_size_ml: 750,
      bottle_size: '750ml',
      closure: 'Cork',
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
      searchSnapshotId: doc.searchSnapshotId,
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
      ratingAvg: doc.ratingAvg,
      ratingsCount: doc.ratingsCount,
      reviewCount: doc.reviewCount,
      wineryRatingCount: doc.wineryRatingCount,
      bottleSizeMl: doc.bottleSizeMl,
      bottleSize: doc.bottleSize,
      closure: doc.closure,
    });
    expect(roundTripped.ratingDistribution).toEqual(doc.ratingDistribution);
  });

  it('omits absent optional summary fields while preserving required retrieval document fields', () => {
    const fields = toVespaFields(makeDocument({
      grapePrimary: undefined,
      producerPrestige: undefined,
      drinkingWindowModelVersion: undefined,
      certifications: undefined,
      soilType: undefined,
      producerType: undefined,
      occasion: undefined,
    }));

    expect(fields).not.toHaveProperty('grape_primary');
    expect(fields).not.toHaveProperty('producer_prestige');
    expect(fields).not.toHaveProperty('drinking_window_model_version');
    expect(fields).not.toHaveProperty('certifications');
    expect(fields).not.toHaveProperty('soil_type');
    expect(fields).not.toHaveProperty('producer_type');
    expect(fields).not.toHaveProperty('occasion');

    const roundTripped = fromVespaFields(fields);
    expect(roundTripped.canonicalLabel).toBe('Mapping Wine');
    expect(roundTripped.searchTextEn).toBe('Mapping wine search text');
    expect(roundTripped.grapePrimary).toBeUndefined();
    expect(roundTripped.producerPrestige).toBeUndefined();
    expect(roundTripped.drinkingWindowModelVersion).toBeUndefined();
    expect(roundTripped.certifications).toBeUndefined();
    expect(roundTripped.soilType).toBeUndefined();
    expect(roundTripped.producerType).toBeUndefined();
    expect(roundTripped.occasion).toBeUndefined();
  });

  it('fails closed when an optional summary field is present with the wrong type', () => {
    const fields = toVespaFields(makeDocument());
    fields['occasion'] = 'celebration';

    expect(() => fromVespaFields(fields)).toThrow(/malformed Vespa document/);
  });
});

// E1-P3-7: body/sweetness null vs 0 distinction
describe('fromVespaFields — body/sweetness null vs 0 (E1-P3-7)', () => {
  it('body=0 in Vespa → field is present with value 0 in returned document', () => {
    const doc = fromVespaFields(makeMinimalRequiredFields({ body: 0 }));
    // body=0 is a legitimate "no body" value — must be preserved, not treated as absent
    expect('body' in doc).toBe(true);
    expect(doc.body).toBe(0);
  });

  it('sweetness=0 in Vespa → field is present with value 0 in returned document', () => {
    const doc = fromVespaFields(makeMinimalRequiredFields({ sweetness: 0 }));
    expect('sweetness' in doc).toBe(true);
    expect(doc.sweetness).toBe(0);
  });

  it('body absent from Vespa → field is absent (undefined) in returned document', () => {
    const doc = fromVespaFields(makeMinimalRequiredFields());
    // "no data" → omit key entirely, not body: 0
    expect(doc.body).toBeUndefined();
  });

  it('sweetness absent from Vespa → field is absent (undefined) in returned document', () => {
    const doc = fromVespaFields(makeMinimalRequiredFields());
    expect(doc.sweetness).toBeUndefined();
  });

  it('body=0.5 (non-zero) round-trips correctly', () => {
    const doc = fromVespaFields(makeMinimalRequiredFields({ body: 0.5 }));
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
  it('single-value positive region filter matches region, appellation, and hierarchy', () => {
    const yql = buildSparseFilters(['region:Burgundy']);
    expect(yql).toContain('region contains "Burgundy"');
    expect(yql).toContain('appellation contains "Burgundy"');
    expect(yql).toContain('region_hierarchy contains "Burgundy"');
  });

  it('region negation filter excludes region, appellation, and hierarchy', () => {
    const yql = buildSparseFilters(['region_not:Burgundy']);
    expect(yql).toContain('!(region contains "Burgundy" OR appellation contains "Burgundy" OR region_hierarchy contains "Burgundy")');
  });

  it('region multi-value IN filter applies geography-aware OR semantics per value', () => {
    const yql = buildSparseFilters(['region_in:Burgundy|Barolo']);
    expect(yql).toContain('region contains');
    expect(yql).toContain('appellation contains "Burgundy"');
    expect(yql).toContain('region_hierarchy contains "Barolo"');
  });

  it('region multi-value NOT IN filter excludes geography-aware matches per value', () => {
    const yql = buildSparseFilters(['region_not_in:Burgundy|Barolo']);
    expect(yql).toContain('!(region contains "Burgundy" OR appellation contains "Burgundy" OR region_hierarchy contains "Burgundy")');
    expect(yql).toContain('!(region contains "Barolo" OR appellation contains "Barolo" OR region_hierarchy contains "Barolo")');
  });

  it('regression: country, wine_type, appellation positive filters still work', () => {
    expect(buildSparseFilters(['country:France'])).toContain('country contains "France"');
    expect(buildSparseFilters(['wine_type:red'])).toContain('wine_type contains "red"');
    expect(buildSparseFilters(['appellation:Pomerol'])).toContain('appellation contains "Pomerol"');
  });

  it('supports explicit search_snapshot_id scoping filters', () => {
    expect(buildSparseFilters(['search_snapshot_id:search-snapshot:v1:target']))
      .toContain('search_snapshot_id contains "search-snapshot:v1:target"');
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

describe('source_record_refs_json (entity lineage)', () => {
  const lineage = [{ sourceSystem: SOURCE_SYSTEM_VIVINO_SILVER, sourceRecordId: 'silver-lineage-1' }] as const;

  it('toVespaFields writes stable JSON on source_record_refs_json', () => {
    const doc = makeDocument({ sourceRecordRefs: [...lineage] });
    const fields = toVespaFields(doc);
    expect(fields['source_record_refs_json']).toBe(stableJsonStringify([...lineage]));
  });

  it('fromVespaFields and readRawVespaRetrievalSummary roundtrip lineage', () => {
    const doc = makeDocument({ sourceRecordRefs: [...lineage] });
    const fields = toVespaFields(doc);
    const roundTripped = fromVespaFields(fields);
    expect(roundTripped.sourceRecordRefs).toEqual([...lineage]);

    const summary = readRawVespaRetrievalSummary(fields);
    expect(summary.sourceRecordRefs).toEqual([...lineage]);
  });

  it('parseHitSummary parses source_record_refs_json into sourceRecordRefs', () => {
    const doc = makeDocument({ sourceRecordRefs: [...lineage] });
    const fields = toVespaFields(doc);
    const hit = parseHitSummary(fields);
    expect(hit.sourceRecordRefs).toEqual([...lineage]);
  });

  it('toRetrievalHitProjection propagates sourceRecordRefs', () => {
    const doc = makeDocument({ sourceRecordRefs: [...lineage] });
    const proj = toRetrievalHitProjection(doc);
    expect(proj.sourceRecordRefs).toEqual([...lineage]);
  });
});

describe('learned_sparse_weights write cap (read/write parity)', () => {
  // The read side (parseSparseWeightsTensor) drops the WHOLE tensor when cell
  // count exceeds MAX_SPARSE_TENSOR_CELLS (10_000). Without a matching write
  // cap, an oversized doc was indexed but read back as nothing — silent loss.
  const CAP = 10_000;

  function makeSparseDoc(entryCount: number): RetrievalDocument {
    const entries = Array.from({ length: entryCount }, (_, i) => ({
      token: `t${String(i).padStart(6, '0')}`,
      // Strictly increasing weight so "kept = highest-weight" is checkable.
      weight: i + 1,
    }));
    return makeDocument({
      learnedSparseWeights: {
        entries,
        weightSum: entries.reduce((s, e) => s + e.weight, 0),
        modelId: 'splade-test',
        schemaVersion: 1,
      },
    });
  }

  it('caps an oversized tensor on write to MAX_SPARSE_TENSOR_CELLS cells', () => {
    const fields = toVespaFields(makeSparseDoc(CAP + 1));
    const tensor = fields['learned_sparse_weights'] as { cells: unknown[] };
    expect(tensor.cells).toHaveLength(CAP);
  });

  it('keeps the highest-weight cells when truncating', () => {
    const fields = toVespaFields(makeSparseDoc(CAP + 5));
    const tensor = fields['learned_sparse_weights'] as {
      cells: { address: { token: string }; value: number }[];
    };
    let minKept = Number.POSITIVE_INFINITY;
    for (const c of tensor.cells) {
      if (c.value < minKept) minKept = c.value;
    }
    // The 5 lowest weights (1..5) must have been dropped, so the smallest
    // surviving weight is strictly greater than 5.
    expect(minKept).toBeGreaterThan(5);
  });

  it('a capped tensor round-trips (read side no longer drops it)', () => {
    const fields = toVespaFields(makeSparseDoc(CAP + 1));
    const roundTripped = fromVespaFields(fields);
    expect(roundTripped.learnedSparseWeights).toBeDefined();
    expect(roundTripped.learnedSparseWeights!.entries).toHaveLength(CAP);
  });

  it('leaves an at-cap tensor untouched', () => {
    const fields = toVespaFields(makeSparseDoc(CAP));
    const tensor = fields['learned_sparse_weights'] as { cells: unknown[] };
    expect(tensor.cells).toHaveLength(CAP);
  });
});
