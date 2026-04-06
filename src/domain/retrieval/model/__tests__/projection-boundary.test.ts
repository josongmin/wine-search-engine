/**
 * T7.1 — Projection Boundary Redefinition
 *
 * Structural tests that verify the decomposition of RetrievalDocument into
 * explicit projection families (RetrievalHitProjection, RetrievalFeatureProjection)
 * and the alignment of RetrievalHitSummary with the hit projection boundary.
 */

import { describe, it, expect } from 'vitest';
import type {
  RetrievalDocument,
  RetrievalHitProjection,
  RetrievalFeatureProjection,
} from '../retrieval-document.js';
import type { RetrievalHitSummary } from '../../port/search-index.port.js';
import {
  toRetrievalHitProjection,
  toRetrievalFeatureProjection,
} from '../../../../infrastructure/vespa/mapping.js';
import { createEntityId } from '../../../shared/types/entity-id.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalRetrievalDoc(): RetrievalDocument {
  return {
    entityId: createEntityId('wine-001'),
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    aliasesIdentitySafe: [],
    aliasesNoisyRecall: [],
    producer: 'Opus One Winery',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '',
    searchTextEn: 'Rich, full-bodied red with dark fruit.',
    semanticSummary: 'Opus One 2018 Opus One Winery Napa Valley Cabernet Sauvignon.',
    body: 0.8,
    sweetness: 0.2,
    style: 'bold red',
    priceBand: 'luxury',
    pairing: ['beef', 'lamb'],
    occasion: ['celebration'],
    availability: true,
    popularityScore: 0.95,
  };
}

function makeFullRetrievalDoc(): RetrievalDocument {
  return {
    ...makeMinimalRetrievalDoc(),
    vintageYear: 2018,
    acidity: 0.6,
    tannin: 0.75,
    grapePrimary: 'Cabernet Sauvignon',
    appellation: 'Oakville',
    producerPrestige: 0.9,
    criticScoreNormalized: 0.96,
    drinkingWindowStart: 2024,
    drinkingWindowEnd: 2040,
    drinkingWindowModelVersion: 'v1',
    country: 'USA',
    wineType: 'red',
    classification: 'Napa Valley AVA',
    alcoholPct: 14.5,
    priceUsd: 350,
    flavorProfiles: ['blackcurrant', 'cedar', 'tobacco'],
    certifications: ['organic'],
    soilType: 'gravel',
    producerType: 'winery',
  };
}

// ---------------------------------------------------------------------------
// Structural type-level tests
// ---------------------------------------------------------------------------

describe('Projection boundary structural types', () => {
  it('RetrievalDocument is assignable to RetrievalHitProjection', () => {
    // Type-level assertion: if this compiles, RetrievalDocument satisfies RetrievalHitProjection.
    const doc: RetrievalDocument = makeMinimalRetrievalDoc();
    const asHit: RetrievalHitProjection = doc;
    expect(asHit.canonicalLabel).toBe('Opus One 2018');
  });

  it('RetrievalDocument is assignable to RetrievalFeatureProjection', () => {
    // Type-level assertion: if this compiles, RetrievalDocument satisfies RetrievalFeatureProjection.
    const doc: RetrievalDocument = makeFullRetrievalDoc();
    const asFeature: RetrievalFeatureProjection = doc;
    expect(asFeature.criticScoreNormalized).toBeCloseTo(0.96);
  });

  it('RetrievalHitSummary extends RetrievalHitProjection (structural alignment)', () => {
    // RetrievalHitSummary extends RetrievalHitProjection — verified by assigning a
    // RetrievalHitSummary where a RetrievalHitProjection is expected.
    const summary: RetrievalHitSummary = {
      canonicalLabel: 'Test Wine 2020',
      producer: 'Test Winery',
      region: 'Bordeaux',
      grapePrimary: 'Merlot',
      vintageYear: 2020,
      searchTextEn: 'Smooth and elegant.',
      producerPrestige: 0.7,
    };
    const asProjection: RetrievalHitProjection = summary;
    expect(asProjection.canonicalLabel).toBe('Test Wine 2020');
  });
});

// ---------------------------------------------------------------------------
// Runtime tests for toRetrievalHitProjection
// ---------------------------------------------------------------------------

describe('toRetrievalHitProjection', () => {
  it('returns only hit projection fields from a full RetrievalDocument', () => {
    const doc = makeFullRetrievalDoc();
    const hit = toRetrievalHitProjection(doc);

    // Hit fields should be present
    expect(hit.entityId).toBe(doc.entityId);
    expect(hit.canonicalLabel).toBe('Opus One 2018');
    expect(hit.producer).toBe('Opus One Winery');
    expect(hit.region).toBe('Napa Valley');
    expect(hit.appellation).toBe('Oakville');
    expect(hit.grapePrimary).toBe('Cabernet Sauvignon');
    expect(hit.vintageYear).toBe(2018);
    expect(hit.searchTextEn).toBe('Rich, full-bodied red with dark fruit.');
    expect(hit.producerPrestige).toBeCloseTo(0.9);
  });

  it('does NOT include feature-only fields', () => {
    const doc = makeFullRetrievalDoc();
    const hit = toRetrievalHitProjection(doc);

    // Feature fields must not leak into the hit projection
    expect((hit as Record<string, unknown>)['body']).toBeUndefined();
    expect((hit as Record<string, unknown>)['tannin']).toBeUndefined();
    expect((hit as Record<string, unknown>)['acidity']).toBeUndefined();
    expect((hit as Record<string, unknown>)['sweetness']).toBeUndefined();
    expect((hit as Record<string, unknown>)['criticScoreNormalized']).toBeUndefined();
    expect((hit as Record<string, unknown>)['drinkingWindowStart']).toBeUndefined();
    expect((hit as Record<string, unknown>)['drinkingWindowEnd']).toBeUndefined();
    expect((hit as Record<string, unknown>)['drinkingWindowModelVersion']).toBeUndefined();
    expect((hit as Record<string, unknown>)['grapePrimaryEnc']).toBeUndefined();
    expect((hit as Record<string, unknown>)['regionEnc']).toBeUndefined();
    expect((hit as Record<string, unknown>)['countryEnc']).toBeUndefined();
  });

  it('does NOT include payload fields (aliasesIdentitySafe, grapes, style, etc.)', () => {
    const doc = makeFullRetrievalDoc();
    const hit = toRetrievalHitProjection(doc);

    expect((hit as Record<string, unknown>)['entityType']).toBeUndefined();
    expect((hit as Record<string, unknown>)['aliasesIdentitySafe']).toBeUndefined();
    expect((hit as Record<string, unknown>)['aliasesNoisyRecall']).toBeUndefined();
    expect((hit as Record<string, unknown>)['grapes']).toBeUndefined();
    expect((hit as Record<string, unknown>)['style']).toBeUndefined();
    expect((hit as Record<string, unknown>)['priceBand']).toBeUndefined();
    expect((hit as Record<string, unknown>)['availability']).toBeUndefined();
    expect((hit as Record<string, unknown>)['popularityScore']).toBeUndefined();
    expect((hit as Record<string, unknown>)['flavorProfiles']).toBeUndefined();
    expect((hit as Record<string, unknown>)['learnedSparseWeights']).toBeUndefined();
  });

  it('omits optional hit fields that are absent on the document', () => {
    const doc = makeMinimalRetrievalDoc(); // no vintageYear, appellation, producerPrestige
    const hit = toRetrievalHitProjection(doc);

    expect(hit.vintageYear).toBeUndefined();
    expect(hit.appellation).toBeUndefined();
    expect(hit.producerPrestige).toBeUndefined();
    expect(hit.grapePrimary).toBeUndefined();
    expect(hit.avgCriticProxyScore).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Runtime tests for toRetrievalFeatureProjection
// ---------------------------------------------------------------------------

describe('toRetrievalFeatureProjection', () => {
  it('returns only feature projection fields from a full RetrievalDocument', () => {
    const doc = makeFullRetrievalDoc();
    const feature = toRetrievalFeatureProjection(doc);

    // Feature fields should be present
    expect(feature.entityId).toBe(doc.entityId);
    expect(feature.tannin).toBeCloseTo(0.75);
    expect(feature.acidity).toBeCloseTo(0.6);
    expect(feature.criticScoreNormalized).toBeCloseTo(0.96);
    expect(feature.drinkingWindowStart).toBe(2024);
    expect(feature.drinkingWindowEnd).toBe(2040);
    expect(feature.drinkingWindowModelVersion).toBe('v1');
  });

  it('does NOT include hit display fields (canonicalLabel, region, searchTextEn, etc.)', () => {
    const doc = makeFullRetrievalDoc();
    const feature = toRetrievalFeatureProjection(doc);

    expect((feature as Record<string, unknown>)['canonicalLabel']).toBeUndefined();
    expect((feature as Record<string, unknown>)['producer']).toBeUndefined();
    expect((feature as Record<string, unknown>)['region']).toBeUndefined();
    expect((feature as Record<string, unknown>)['appellation']).toBeUndefined();
    expect((feature as Record<string, unknown>)['grapePrimary']).toBeUndefined();
    expect((feature as Record<string, unknown>)['searchTextEn']).toBeUndefined();
    expect((feature as Record<string, unknown>)['producerPrestige']).toBeUndefined();
    expect((feature as Record<string, unknown>)['vintage']).toBeUndefined();
    expect((feature as Record<string, unknown>)['vintageYear']).toBeUndefined();
    expect((feature as Record<string, unknown>)['avgCriticProxyScore']).toBeUndefined();
  });

  it('does NOT include payload fields', () => {
    const doc = makeFullRetrievalDoc();
    const feature = toRetrievalFeatureProjection(doc);

    expect((feature as Record<string, unknown>)['entityType']).toBeUndefined();
    expect((feature as Record<string, unknown>)['aliasesIdentitySafe']).toBeUndefined();
    expect((feature as Record<string, unknown>)['grapes']).toBeUndefined();
    expect((feature as Record<string, unknown>)['style']).toBeUndefined();
    expect((feature as Record<string, unknown>)['availability']).toBeUndefined();
    expect((feature as Record<string, unknown>)['popularityScore']).toBeUndefined();
    expect((feature as Record<string, unknown>)['learnedSparseWeights']).toBeUndefined();
  });

  it('omits optional feature fields absent on the document', () => {
    const doc = makeMinimalRetrievalDoc(); // no tannin, acidity, criticScoreNormalized, etc.
    const feature = toRetrievalFeatureProjection(doc);

    expect(feature.tannin).toBeUndefined();
    expect(feature.acidity).toBeUndefined();
    expect(feature.criticScoreNormalized).toBeUndefined();
    expect(feature.drinkingWindowStart).toBeUndefined();
    expect(feature.drinkingWindowEnd).toBeUndefined();
    expect(feature.drinkingWindowModelVersion).toBeUndefined();
    expect(feature.grapePrimaryEnc).toBeUndefined();
    expect(feature.regionEnc).toBeUndefined();
    expect(feature.countryEnc).toBeUndefined();
  });
});
