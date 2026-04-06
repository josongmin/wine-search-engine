import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../shared/types/index.js';
import type { RetrievalDocument } from '../model/retrieval-document.js';
import type { RetrievalHitSummary } from '../port/search-index.port.js';
import {
  mergeRetrievalHitSummaries,
  normalizeRetrievalHitSummary,
  normalizeSummarySearchText,
  retrievalDocumentToHitSummary,
  summaryToHybridCandidateFields,
} from '../service/hybrid-candidate-summary.js';

function makeDocument(
  overrides: Partial<RetrievalDocument> = {},
): RetrievalDocument {
  return {
    entityId: createEntityId('wine-summary-test'),
    entityType: 'wine',
    canonicalLabel: 'Summary Test Wine',
    aliasesIdentitySafe: ['Summary Test Wine'],
    aliasesNoisyRecall: [],
    producer: 'Test Producer',
    region: 'Test Region',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: '요약 테스트 와인',
    searchTextEn: 'Summary test wine',
    semanticSummary: 'Summary test wine semantic summary',
    body: 0.7,
    sweetness: 0.2,
    style: 'structured red',
    priceBand: 'premium',
    pairing: ['steak'],
    occasion: ['dinner'],
    availability: true,
    popularityScore: 0.9,
    ...overrides,
  };
}

describe('hybrid candidate summary helpers', () => {
  it('maps the full retrieval summary contract onto hybrid candidates', () => {
    const summary: RetrievalHitSummary = {
      canonicalLabel: 'Mapped Wine',
      producer: 'Mapped Producer',
      region: 'Mapped Region',
      searchTextEn: 'Mapped search text',
      grapePrimary: 'Nebbiolo',
      style: 'savory red',
      priceBand: 'luxury',
      pairing: ['truffle'],
      occasion: ['cellaring'],
      vintageYear: 2019,
      body: 0.8,
      tannin: 0.7,
      acidity: 0.6,
      sweetness: 0.1,
      finishLength: 0.9,
      wineType: 'red',
      criticScoreNormalized: 0.95,
      producerPrestige: 0.88,
      country: 'Italy',
      appellation: 'Barolo',
      classification: 'DOCG',
      alcoholPct: 14.5,
      drinkingWindowStart: 2027,
      drinkingWindowEnd: 2040,
      drinkingWindowModelVersion: 'dw-v3',
      priceUsd: 245,
      certifications: ['organic'],
      soilType: 'limestone',
      producerType: 'domaine',
    };

    expect(summaryToHybridCandidateFields(summary)).toEqual(summary);
  });

  it('merges summary fields by precedence without dropping late-contract fields', () => {
    const sparse: RetrievalHitSummary = {
      canonicalLabel: 'Sparse Wine',
      producer: 'Sparse Producer',
      body: 0.7,
      sweetness: 0.1,
    };
    const dense: RetrievalHitSummary = {
      producerPrestige: 0.91,
      country: 'France',
      drinkingWindowStart: 2028,
      drinkingWindowEnd: 2042,
    };
    const anchor: RetrievalHitSummary = {
      drinkingWindowModelVersion: 'dw-anchor-v2',
      priceUsd: 180,
      certifications: ['biodynamic'],
      producerType: 'estate',
    };

    expect(mergeRetrievalHitSummaries(sparse, dense, anchor)).toEqual({
      canonicalLabel: 'Sparse Wine',
      producer: 'Sparse Producer',
      body: 0.7,
      sweetness: 0.1,
      producerPrestige: 0.91,
      country: 'France',
      drinkingWindowStart: 2028,
      drinkingWindowEnd: 2042,
      drinkingWindowModelVersion: 'dw-anchor-v2',
      priceUsd: 180,
      certifications: ['biodynamic'],
      producerType: 'estate',
    });
  });

  it('normalizes retrieval documents through the shared transport shape', () => {
    const summary = retrievalDocumentToHitSummary(
      makeDocument({
        producer: '  Test Producer  ',
        region: '  Napa Valley ',
        grapes: ['  Cabernet Franc  '],
        grapePrimary: '   ',
        searchTextEn: `${'A'.repeat(810)}   `,
        classification: '  Grand Cru  ',
        drinkingWindowModelVersion: '  dw-doc-v1  ',
        soilType: '  gravel  ',
        producerType: '  winery  ',
      }),
    );

    expect(summary).toMatchObject({
      canonicalLabel: 'Summary Test Wine',
      producer: 'Test Producer',
      region: 'Napa Valley',
      grapePrimary: 'Cabernet Franc',
      classification: 'Grand Cru',
      drinkingWindowModelVersion: 'dw-doc-v1',
      soilType: 'gravel',
      producerType: 'winery',
    });
    expect(summary.searchTextEn).toHaveLength(800);
  });

  it('drops undefined keys while preserving defined summary fields', () => {
    expect(
      normalizeRetrievalHitSummary({
        canonicalLabel: 'Normalized Wine',
        producer: undefined,
        drinkingWindowModelVersion: 'dw-v5',
      }),
    ).toEqual({
      canonicalLabel: 'Normalized Wine',
      drinkingWindowModelVersion: 'dw-v5',
    });
  });

  it('uses the shared search text normalizer for trim and truncation', () => {
    expect(normalizeSummarySearchText(`  ${'B'.repeat(810)}  `)).toBe('B'.repeat(800));
    expect(normalizeSummarySearchText('   ')).toBeUndefined();
  });
});
