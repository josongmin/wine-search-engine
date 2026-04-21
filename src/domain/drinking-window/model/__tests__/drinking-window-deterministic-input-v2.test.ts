import { describe, expect, it } from 'vitest';
import {
  DRINKING_WINDOW_DETERMINISTIC_FIELD_SPECS,
  DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPES,
  DRINKING_WINDOW_DETERMINISTIC_WINE_TYPES,
  DRINKING_WINDOW_SOURCE_CONFIDENCE_LEVELS,
  DrinkingWindowDeterministicInputV2Schema,
  toDrinkingWindowDeterministicInputV2,
} from '../drinking-window-deterministic-input-v2.js';

describe('DrinkingWindowDeterministicInputV2Schema', () => {
  it('accepts the wide deterministic input envelope', () => {
    const parsed = DrinkingWindowDeterministicInputV2Schema.parse({
      vintage: 2018,
      grapePrimaryEnc: 42,
      regionEnc: 10,
      countryEnc: 1,
      grapePrimary: 'Nebbiolo',
      producer: 'Giacomo Conterno',
      grapes: ['Nebbiolo'],
      country: 'Italy',
      region: 'Piedmont',
      appellation: 'Barolo',
      regionHierarchy: ['Italy', 'Piedmont', 'Barolo'],
      grapeFamily: 'nebbiolo_family',
      wineType: 'red',
      style: 'structured red',
      classification: 'DOCG',
      oakTreatment: 'large oak cask',
      producerType: 'estate',
      certifications: ['organic', 'biodynamic'],
      soilType: 'limestone',
      body: 4,
      tannin: 4,
      acidity: 3,
      sweetness: 1,
      finishLength: 0.9,
      alcoholPct: 14.5,
      avgCriticProxyScore: 95,
      ratingAvg: 4.7,
      ratingsCount: 1287,
      reviewCount: 211,
      ratingDistribution: { '1': 2, '2': 10, '3': 115, '4': 540, '5': 620 },
      criticScoreNormalized: 0.97,
      producerPrestige: 0.95,
      wineryRatingCount: 8240,
      priceUsd: 150,
      bottleSizeMl: 750,
      bottleSize: '750ml',
      closure: 'Cork',
      priorDrinkingWindowStart: 2025,
      priorDrinkingWindowEnd: 2040,
      priorDrinkingWindowModelVersion: 'onnx:v2.1',
      hasCompleteStructureSignals: true,
      sourceConfidence: 'high',
    });

    expect(parsed.regionHierarchy).toEqual(['Italy', 'Piedmont', 'Barolo']);
  });

  it('rejects prior window ranges where end precedes start', () => {
    const parsed = DrinkingWindowDeterministicInputV2Schema.safeParse({
      vintage: 2018,
      priorDrinkingWindowStart: 2030,
      priorDrinkingWindowEnd: 2025,
    });

    expect(parsed.success).toBe(false);
  });
});

describe('DRINKING_WINDOW_DETERMINISTIC_FIELD_SPECS', () => {
  it('documents every schema field with type/source metadata', () => {
    expect(Object.keys(DRINKING_WINDOW_DETERMINISTIC_FIELD_SPECS).sort()).toEqual([
      'acidity',
      'alcoholPct',
      'appellation',
      'avgCriticProxyScore',
      'body',
      'bottleSize',
      'bottleSizeMl',
      'certifications',
      'classification',
      'closure',
      'country',
      'countryEnc',
      'criticScoreNormalized',
      'finishLength',
      'grapeFamily',
      'grapePrimary',
      'grapePrimaryEnc',
      'grapes',
      'hasCompleteStructureSignals',
      'oakTreatment',
      'priceUsd',
      'priorDrinkingWindowEnd',
      'priorDrinkingWindowModelVersion',
      'priorDrinkingWindowStart',
      'producer',
      'producerPrestige',
      'producerType',
      'ratingAvg',
      'ratingDistribution',
      'ratingsCount',
      'region',
      'regionEnc',
      'regionHierarchy',
      'reviewCount',
      'soilType',
      'sourceConfidence',
      'style',
      'sweetness',
      'tannin',
      'vintage',
      'wineType',
      'wineryRatingCount',
    ]);
    expect(DRINKING_WINDOW_DETERMINISTIC_FIELD_SPECS.wineType.enumValues).toEqual(
      DRINKING_WINDOW_DETERMINISTIC_WINE_TYPES,
    );
    expect(DRINKING_WINDOW_DETERMINISTIC_FIELD_SPECS.producerType.enumValues).toEqual(
      DRINKING_WINDOW_DETERMINISTIC_PRODUCER_TYPES,
    );
    expect(DRINKING_WINDOW_DETERMINISTIC_FIELD_SPECS.sourceConfidence.enumValues).toEqual(
      DRINKING_WINDOW_SOURCE_CONFIDENCE_LEVELS,
    );
  });
});

describe('toDrinkingWindowDeterministicInputV2', () => {
  it('upcasts the legacy narrow predictor input into the wide deterministic schema', () => {
    expect(
      toDrinkingWindowDeterministicInputV2({
        vintage: 2020,
        grapePrimaryEnc: 1,
        regionEnc: 2,
        countryEnc: 3,
        body: 4,
        tannin: 3,
        acidity: 2,
        sweetness: 1,
        avgCriticProxyScore: 90,
      }),
    ).toEqual({
      vintage: 2020,
      grapePrimaryEnc: 1,
      regionEnc: 2,
      countryEnc: 3,
      body: 4,
      tannin: 3,
      acidity: 2,
      sweetness: 1,
      avgCriticProxyScore: 90,
    });
  });
});
