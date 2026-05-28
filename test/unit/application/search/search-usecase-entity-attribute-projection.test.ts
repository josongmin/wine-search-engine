import { describe, expect, it } from 'vitest';
import {
  applyAttributeHintsToSyntheticHybridCandidate,
  buildResolverCandidateAttributeHints,
  ENTITY_ATTRIBUTE_HINT_KEYS,
} from '../../../../src/application/search/search-usecase-entity-attribute-projection.js';
import type { RetrievalDocument } from '../../../../src/domain/retrieval/model/retrieval-document.js';
import type { HybridCandidate } from '../../../../src/domain/retrieval/model/hybrid-candidate.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import { LLM_ALLOWED_ATTRIBUTES } from '../../../../src/domain/attribute/model/llm-constraint-schema.js';
import { SOFT_CONSTRAINT_ATTRIBUTES } from '../../../../src/domain/shared/constants/constraint-attributes.js';

function makeDocument(): RetrievalDocument {
  return {
    entityId: createEntityId('wine-kalaris'),
    entityType: 'wine',
    canonicalLabel: '2014 Kalaris Merlot',
    aliasesIdentitySafe: ['Kalaris Merlot'],
    aliasesNoisyRecall: ['Kalaris'],
    producer: 'Kalaris',
    region: 'Napa Valley',
    appellation: 'Oak Knoll District',
    country: 'United States',
    regionHierarchy: ['United States', 'California', 'Napa Valley'],
    grapes: ['Merlot', 'Cabernet Sauvignon'],
    grapePrimary: 'Merlot',
    searchTextKo: '칼라리스 메를로',
    searchTextEn: '2014 Kalaris Merlot Napa Valley',
    semanticSummary: 'Merlot from Napa Valley',
    style: 'velvety red',
    closure: 'Screw cap',
    priceBand: 'premium',
    pairing: ['beef'],
    occasion: ['dinner'],
    availability: true,
    popularityScore: 0.7,
    vintageYear: 2014,
    body: 4,
    sweetness: 1,
    acidity: 3,
    tannin: 2,
    finishLength: 0.8,
    wineType: 'red',
    classification: 'Estate',
    alcoholPct: 14.2,
    priceUsd: 79,
    producerPrestige: 0.66,
    criticScoreNormalized: 0.93,
    certifications: ['organic'],
    soilType: 'volcanic',
    producerType: 'estate',
    grapeFamily: 'merlot_family',
    flavorProfiles: ['fruity', 'spicy'],
    drinkingWindowStart: 2022,
    drinkingWindowEnd: 2030,
    drinkingWindowModelVersion: 'dw-v1',
  };
}

function makeBaseCandidate(): HybridCandidate {
  return {
    entityId: createEntityId('wine-kalaris'),
    canonicalLabel: '2014 Kalaris Merlot',
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'entity_route_synthetic',
      lexicalQueriesUsed: [],
      semanticQueriesUsed: [],
      filtersApplied: [],
      candidateSources: ['entity_resolver'],
    },
  };
}

describe('entity attribute projection SSOT', () => {
  it('round-trips supported retrieval fields through attributeHints into synthetic candidates', () => {
    const hints = buildResolverCandidateAttributeHints(makeDocument());
    expect(hints).toBeDefined();

    const projected = applyAttributeHintsToSyntheticHybridCandidate(
      makeBaseCandidate(),
      hints,
    );

    expect(projected.producer).toBe('Kalaris');
    expect(projected.region).toBe('Napa Valley');
    expect(projected.appellation).toBe('Oak Knoll District');
    expect(projected.country).toBe('United States');
    expect(projected.regionHierarchy).toEqual(['United States', 'California', 'Napa Valley']);
    expect(projected.grapePrimary).toBe('Merlot');
    expect(projected.grapes).toEqual(['Merlot', 'Cabernet Sauvignon']);
    expect(projected.style).toBe('velvety red');
    expect(projected.closure).toBe('Screw cap');
    expect(projected.priceBand).toBe('premium');
    expect(projected.pairing).toEqual(['beef']);
    expect(projected.occasion).toEqual(['dinner']);
    expect(projected.vintageYear).toBe(2014);
    expect(projected.body).toBe(4);
    expect(projected.acidity).toBe(3);
    expect(projected.tannin).toBe(2);
    expect(projected.sweetness).toBe(1);
    expect(projected.finishLength).toBe(0.8);
    expect(projected.wineType).toBe('red');
    expect(projected.classification).toBe('Estate');
    expect(projected.alcoholPct).toBe(14.2);
    expect(projected.priceUsd).toBe(79);
    expect(projected.producerPrestige).toBe(0.66);
    expect(projected.criticScoreNormalized).toBe(0.93);
    expect(projected.certifications).toEqual(['organic']);
    expect(projected.soilType).toBe('volcanic');
    expect(projected.producerType).toBe('estate');
    expect(projected.grapeFamily).toBe('merlot_family');
    expect(projected.flavorProfiles).toEqual(['fruity', 'spicy']);
    expect(projected.drinkingWindowStart).toBe(2022);
    expect(projected.drinkingWindowEnd).toBe(2030);
    expect(projected.drinkingWindowModelVersion).toBe('dw-v1');
  });

  it('projects every LLM-allowed hard attribute that has a retrieval backing field', () => {
    const hardAllowedAttributes = [...LLM_ALLOWED_ATTRIBUTES]
      .filter((attribute) => !SOFT_CONSTRAINT_ATTRIBUTES.has(attribute))
      .sort();

    expect(ENTITY_ATTRIBUTE_HINT_KEYS).toEqual(expect.arrayContaining([
      'appellation',
      'country',
      'grape_primary',
      'region',
      'wine_type',
    ]));
    expect(hardAllowedAttributes).toEqual([
      'appellation',
      'country',
      'grape_primary',
      'region',
      'wine_type',
    ]);
  });

  it('covers critical soft attributes that still need entity-route projection parity', () => {
    expect(ENTITY_ATTRIBUTE_HINT_KEYS).toEqual(expect.arrayContaining([
      'drinking_window_end',
      'drinking_window_model_version',
      'drinking_window_start',
      'finish_length',
      'flavor_profiles',
      'closure',
      'price_band',
      'producer_prestige',
    ]));
  });
});
