/**
 * T7.2 — Vespa Schema / Summary Redesign: Projection Summary Parser Tests
 *
 * Verifies that:
 *  - parseHitSummary returns only RetrievalHitProjection fields
 *  - parseFeatureSummary returns only RetrievalFeatureProjection fields
 *  - roundtrip: toVespaFields(doc) → parseHitSummary gives correct hit values
 *  - unknown fields in summary raw object are ignored (no crash)
 */

import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';
import {
  parseHitSummary,
  parseFeatureSummary,
  toVespaFields,
} from '../mapping.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFullDocument(overrides: Partial<RetrievalDocument> = {}): RetrievalDocument {
  return {
    entityId: createEntityId('proj-test-001'),
    entityType: 'wine',
    canonicalLabel: 'Domaine Leroy Chambertin 2015',
    aliasesIdentitySafe: ['Leroy Chambertin 2015'],
    aliasesNoisyRecall: ['Leroy Chambertin'],
    producer: 'Domaine Leroy',
    region: 'Burgundy',
    grapes: ['Pinot Noir'],
    searchTextKo: '도멘 르루아 샹베르탱',
    searchTextEn: 'Leroy Chambertin elegant red Burgundy',
    semanticSummary: 'Domaine Leroy Chambertin Grand Cru Pinot Noir.',
    body: 0.75,
    sweetness: 0.1,
    style: 'elegant red',
    priceBand: 'luxury',
    pairing: ['duck', 'mushroom'],
    occasion: ['celebration'],
    availability: true,
    popularityScore: 0.98,
    vintageYear: 2015,
    acidity: 0.65,
    tannin: 0.7,
    grapePrimary: 'Pinot Noir',
    appellation: 'Chambertin Grand Cru',
    producerPrestige: 0.97,
    criticScoreNormalized: 0.99,
    drinkingWindowStart: 2025,
    drinkingWindowEnd: 2045,
    drinkingWindowModelVersion: 'dw-v5',
    country: 'France',
    wineType: 'red',
    classification: 'Grand Cru',
    alcoholPct: 13.0,
    priceUsd: 2800,
    flavorProfiles: ['cherry', 'earth', 'violet'],
    certifications: ['biodynamic'],
    soilType: 'limestone',
    producerType: 'domaine',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseHitSummary
// ---------------------------------------------------------------------------

describe('parseHitSummary', () => {
  it('returns only hit projection fields from a full raw summary', () => {
    const doc = makeFullDocument();
    const raw = toVespaFields(doc);

    const hit = parseHitSummary(raw);

    // Hit fields should be present
    expect(hit.entityId).toBe(doc.entityId);
    expect(hit.canonicalLabel).toBe('Domaine Leroy Chambertin 2015');
    expect(hit.producer).toBe('Domaine Leroy');
    expect(hit.region).toBe('Burgundy');
    expect(hit.appellation).toBe('Chambertin Grand Cru');
    expect(hit.grapePrimary).toBe('Pinot Noir');
    expect(hit.vintageYear).toBe(2015);
    expect(hit.searchTextEn).toBe('Leroy Chambertin elegant red Burgundy');
    expect(hit.producerPrestige).toBeCloseTo(0.97);
  });

  it('does NOT include feature fields (body, tannin, acidity, sweetness, criticScoreNormalized)', () => {
    const doc = makeFullDocument();
    const raw = toVespaFields(doc);

    const hit = parseHitSummary(raw);
    const asRecord = hit as Record<string, unknown>;

    expect(asRecord['body']).toBeUndefined();
    expect(asRecord['tannin']).toBeUndefined();
    expect(asRecord['acidity']).toBeUndefined();
    expect(asRecord['sweetness']).toBeUndefined();
    expect(asRecord['criticScoreNormalized']).toBeUndefined();
    expect(asRecord['drinkingWindowStart']).toBeUndefined();
    expect(asRecord['drinkingWindowEnd']).toBeUndefined();
    expect(asRecord['drinkingWindowModelVersion']).toBeUndefined();
    expect(asRecord['grapePrimaryEnc']).toBeUndefined();
    expect(asRecord['regionEnc']).toBeUndefined();
    expect(asRecord['countryEnc']).toBeUndefined();
  });

  it('does NOT include payload fields (aliasesIdentitySafe, style, priceBand, etc.)', () => {
    const doc = makeFullDocument();
    const raw = toVespaFields(doc);

    const hit = parseHitSummary(raw);
    const asRecord = hit as Record<string, unknown>;

    expect(asRecord['entityType']).toBeUndefined();
    expect(asRecord['aliasesIdentitySafe']).toBeUndefined();
    expect(asRecord['aliasesNoisyRecall']).toBeUndefined();
    expect(asRecord['grapes']).toBeUndefined();
    expect(asRecord['style']).toBeUndefined();
    expect(asRecord['priceBand']).toBeUndefined();
    expect(asRecord['pairing']).toBeUndefined();
    expect(asRecord['occasion']).toBeUndefined();
    expect(asRecord['availability']).toBeUndefined();
    expect(asRecord['popularityScore']).toBeUndefined();
    expect(asRecord['flavorProfiles']).toBeUndefined();
    expect(asRecord['learnedSparseWeights']).toBeUndefined();
  });

  it('omits optional hit fields that are absent from raw', () => {
    // Only entity_id and canonical_label present
    const raw: Record<string, unknown> = {
      entity_id: 'proj-test-002',
      canonical_label: 'Minimal Wine',
    };

    const hit = parseHitSummary(raw);

    expect(hit.entityId).toBe('proj-test-002');
    expect(hit.canonicalLabel).toBe('Minimal Wine');
    expect(hit.producer).toBeUndefined();
    expect(hit.region).toBeUndefined();
    expect(hit.appellation).toBeUndefined();
    expect(hit.grapePrimary).toBeUndefined();
    expect(hit.vintageYear).toBeUndefined();
    expect(hit.searchTextEn).toBeUndefined();
    expect(hit.producerPrestige).toBeUndefined();
  });

  it('ignores unknown fields in the raw summary without crashing', () => {
    const raw: Record<string, unknown> = {
      entity_id: 'proj-test-003',
      canonical_label: 'Unknown Field Wine',
      unknown_vespa_field_xyz: 'should be ignored',
      another_unknown: 42,
      nested_unknown: { deep: true },
    };

    expect(() => parseHitSummary(raw)).not.toThrow();
    const hit = parseHitSummary(raw);
    expect(hit.canonicalLabel).toBe('Unknown Field Wine');
    expect((hit as Record<string, unknown>)['unknown_vespa_field_xyz']).toBeUndefined();
    expect((hit as Record<string, unknown>)['another_unknown']).toBeUndefined();
  });

  it('roundtrip: toVespaFields(doc) → parseHitSummary gives correct hit values', () => {
    const doc = makeFullDocument();
    const vespaFields = toVespaFields(doc);

    const hit = parseHitSummary(vespaFields);

    expect(hit.entityId).toBe(doc.entityId);
    expect(hit.canonicalLabel).toBe(doc.canonicalLabel);
    expect(hit.producer).toBe(doc.producer);
    expect(hit.region).toBe(doc.region);
    expect(hit.appellation).toBe(doc.appellation);
    expect(hit.grapePrimary).toBe(doc.grapePrimary);
    expect(hit.vintageYear).toBe(doc.vintageYear);
    expect(hit.searchTextEn).toBe(doc.searchTextEn);
    expect(hit.producerPrestige).toBeCloseTo(doc.producerPrestige ?? 0);
  });
});

// ---------------------------------------------------------------------------
// parseFeatureSummary
// ---------------------------------------------------------------------------

describe('parseFeatureSummary', () => {
  it('returns only feature projection fields from a full raw summary', () => {
    const doc = makeFullDocument();
    const raw = toVespaFields(doc);

    const feature = parseFeatureSummary(raw);

    expect(feature.entityId).toBe(doc.entityId);
    expect(feature.body).toBeCloseTo(0.75);
    expect(feature.tannin).toBeCloseTo(0.7);
    expect(feature.acidity).toBeCloseTo(0.65);
    expect(feature.sweetness).toBeCloseTo(0.1);
    expect(feature.criticScoreNormalized).toBeCloseTo(0.99);
    expect(feature.drinkingWindowStart).toBe(2025);
    expect(feature.drinkingWindowEnd).toBe(2045);
    expect(feature.drinkingWindowModelVersion).toBe('dw-v5');
  });

  it('does NOT include hit display fields (canonicalLabel, producer, region, etc.)', () => {
    const doc = makeFullDocument();
    const raw = toVespaFields(doc);

    const feature = parseFeatureSummary(raw);
    const asRecord = feature as Record<string, unknown>;

    expect(asRecord['canonicalLabel']).toBeUndefined();
    expect(asRecord['producer']).toBeUndefined();
    expect(asRecord['region']).toBeUndefined();
    expect(asRecord['appellation']).toBeUndefined();
    expect(asRecord['grapePrimary']).toBeUndefined();
    expect(asRecord['vintageYear']).toBeUndefined();
    expect(asRecord['searchTextEn']).toBeUndefined();
    expect(asRecord['producerPrestige']).toBeUndefined();
    expect(asRecord['avgCriticProxyScore']).toBeUndefined();
  });

  it('does NOT include payload fields', () => {
    const doc = makeFullDocument();
    const raw = toVespaFields(doc);

    const feature = parseFeatureSummary(raw);
    const asRecord = feature as Record<string, unknown>;

    expect(asRecord['entityType']).toBeUndefined();
    expect(asRecord['aliasesIdentitySafe']).toBeUndefined();
    expect(asRecord['grapes']).toBeUndefined();
    expect(asRecord['style']).toBeUndefined();
    expect(asRecord['availability']).toBeUndefined();
    expect(asRecord['popularityScore']).toBeUndefined();
    expect(asRecord['learnedSparseWeights']).toBeUndefined();
  });

  it('omits optional feature fields that are absent from raw', () => {
    const raw: Record<string, unknown> = {
      entity_id: 'proj-test-004',
    };

    const feature = parseFeatureSummary(raw);

    expect(feature.entityId).toBe('proj-test-004');
    expect(feature.body).toBeUndefined();
    expect(feature.tannin).toBeUndefined();
    expect(feature.acidity).toBeUndefined();
    expect(feature.sweetness).toBeUndefined();
    expect(feature.criticScoreNormalized).toBeUndefined();
    expect(feature.drinkingWindowStart).toBeUndefined();
    expect(feature.drinkingWindowEnd).toBeUndefined();
    expect(feature.drinkingWindowModelVersion).toBeUndefined();
    expect(feature.grapePrimaryEnc).toBeUndefined();
    expect(feature.regionEnc).toBeUndefined();
    expect(feature.countryEnc).toBeUndefined();
  });

  it('ignores unknown fields in the raw summary without crashing', () => {
    const raw: Record<string, unknown> = {
      entity_id: 'proj-test-005',
      body: 0.8,
      completely_unknown_signal: 'ignored',
      nested_unknown: { deep: [1, 2, 3] },
    };

    expect(() => parseFeatureSummary(raw)).not.toThrow();
    const feature = parseFeatureSummary(raw);
    expect(feature.body).toBeCloseTo(0.8);
    expect((feature as Record<string, unknown>)['completely_unknown_signal']).toBeUndefined();
  });

  it('roundtrip: toVespaFields(doc) → parseFeatureSummary gives correct feature values', () => {
    const doc = makeFullDocument();
    const vespaFields = toVespaFields(doc);

    const feature = parseFeatureSummary(vespaFields);

    expect(feature.entityId).toBe(doc.entityId);
    expect(feature.body).toBeCloseTo(doc.body);
    expect(feature.tannin).toBeCloseTo(doc.tannin ?? 0);
    expect(feature.acidity).toBeCloseTo(doc.acidity ?? 0);
    expect(feature.sweetness).toBeCloseTo(doc.sweetness);
    expect(feature.criticScoreNormalized).toBeCloseTo(doc.criticScoreNormalized ?? 0);
    expect(feature.drinkingWindowStart).toBe(doc.drinkingWindowStart);
    expect(feature.drinkingWindowEnd).toBe(doc.drinkingWindowEnd);
    expect(feature.drinkingWindowModelVersion).toBe(doc.drinkingWindowModelVersion);
  });
});

// ---------------------------------------------------------------------------
// Projection family separation: hit_summary vs feature_summary
// ---------------------------------------------------------------------------

describe('Projection family separation', () => {
  it('hit_summary fields and feature_summary fields are disjoint (no overlap)', () => {
    const doc = makeFullDocument();
    const raw = toVespaFields(doc);

    const hit = parseHitSummary(raw) as Record<string, unknown>;
    const feature = parseFeatureSummary(raw) as Record<string, unknown>;

    // Feature-only keys must NOT appear in hit
    const featureOnlyKeys = ['body', 'tannin', 'acidity', 'sweetness', 'criticScoreNormalized',
      'drinkingWindowStart', 'drinkingWindowEnd', 'drinkingWindowModelVersion',
      'grapePrimaryEnc', 'regionEnc', 'countryEnc'];
    for (const key of featureOnlyKeys) {
      expect(hit[key]).toBeUndefined();
    }

    // Hit-only display keys must NOT appear in feature
    const hitOnlyKeys = ['canonicalLabel', 'producer', 'region', 'appellation',
      'grapePrimary', 'vintageYear', 'searchTextEn', 'producerPrestige'];
    for (const key of hitOnlyKeys) {
      expect(feature[key]).toBeUndefined();
    }
  });
});
