import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../shared/types/index.js';
import type { HybridCandidate } from '../../../retrieval/model/hybrid-candidate.js';
import { WineAttributeEncoders } from '../wine-attribute-encoder.js';
import {
  projectHybridCandidateToRankedResultAttributes,
  projectRankedResultSourceAttributes,
} from '../ranked-result-attribute-projection.js';

describe('ranked-result attribute projection', () => {
  it('projects hybrid candidates into the full ranked-result metadata surface', () => {
    const candidate: HybridCandidate = {
      entityId: createEntityId('wine-kalaris'),
      canonicalLabel: '2014 Kalaris Merlot',
      producer: 'Kalaris',
      region: 'Napa Valley',
      grapePrimary: 'Merlot',
      appellation: 'Oak Knoll District',
      country: 'United States',
      producerPrestige: 0.66,
      vintageYear: 2014,
      body: 0.8,
      tannin: 0.4,
      acidity: 0.5,
      sweetness: 0.1,
      criticScoreNormalized: 0.93,
      drinkingWindowStart: 2022,
      drinkingWindowEnd: 2030,
      drinkingWindowModelVersion: 'dw-v1',
      style: 'velvety red',
      classification: 'Estate',
      alcoholPct: 14.2,
      certifications: ['organic'],
      pairing: ['beef'],
      occasion: ['dinner'],
      priceBand: 'premium',
      priceUsd: 79,
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'wine-kalaris' }],
      matchedConstraints: [],
      retrievalTrace: {
        retrievalProfile: 'entity_route_synthetic',
        lexicalQueriesUsed: [],
        semanticQueriesUsed: [],
        filtersApplied: [],
        candidateSources: ['entity_resolver'],
      },
    };

    const projection = projectHybridCandidateToRankedResultAttributes(
      candidate,
      WineAttributeEncoders,
    );

    expect(projection).toMatchObject({
      producer: 'Kalaris',
      region: 'Napa Valley',
      grapePrimary: 'Merlot',
      appellation: 'Oak Knoll District',
      producerPrestige: 0.66,
      vintageYear: 2014,
      body: 0.8,
      tannin: 0.4,
      acidity: 0.5,
      sweetness: 0.1,
      avgCriticProxyScore: 99,
      criticScoreNormalized: 0.93,
      drinkingWindowStart: 2022,
      drinkingWindowEnd: 2030,
      drinkingWindowModelVersion: 'dw-v1',
      style: 'velvety red',
      classification: 'Estate',
      alcoholPct: 14.2,
      certifications: ['organic'],
      pairingTags: ['beef'],
      occasion: ['dinner'],
      priceBand: 'premium',
      priceUsd: 79,
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'wine-kalaris' }],
    });
    expect(projection.grapePrimaryEnc).not.toBeUndefined();
    expect(projection.regionEnc).not.toBeUndefined();
    expect(projection.countryEnc).not.toBeUndefined();
    expect(projection.regionEnc).toBe(WineAttributeEncoders.encodeRegion('Napa Valley'));
    expect(projection.regionEnc).not.toBe(WineAttributeEncoders.encodeRegion('Oak Knoll District'));
  });

  it('projects scored-entry-style sources into ranked-result metadata without recomputing semantics', () => {
    const projection = projectRankedResultSourceAttributes({
      producer: 'Kalaris',
      region: 'Napa Valley',
      grapePrimary: 'Merlot',
      appellation: 'Oak Knoll District',
      producerPrestige: 0.66,
      sparseRank: 1,
      vintageYear: 2014,
      body: 0.8,
      tannin: 0.4,
      acidity: 0.5,
      sweetness: 0.1,
      criticScoreNormalized: 0.93,
      grapePrimaryEnc: 12,
      regionEnc: 34,
      countryEnc: 56,
      drinkingWindowStart: 2022,
      drinkingWindowEnd: 2030,
      drinkingWindowModelVersion: 'dw-v1',
      style: 'velvety red',
      classification: 'Estate',
      alcoholPct: 14.2,
      certifications: ['organic'],
      pairingTags: ['beef'],
      occasion: ['dinner'],
      priceBand: 'premium',
      priceUsd: 79,
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'wine-kalaris' }],
    });

    expect(projection).toMatchObject({
      sparseRank: 1,
      avgCriticProxyScore: 99,
      grapePrimaryEnc: 12,
      regionEnc: 34,
      countryEnc: 56,
      pairingTags: ['beef'],
      occasion: ['dinner'],
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'wine-kalaris' }],
    });
  });
});
