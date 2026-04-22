import { describe, expect, it, vi } from 'vitest';
import { DrinkingWindowUseCase } from '../../../src/application/drinking-window/drinking-window.usecase.js';

describe('DrinkingWindowUseCase', () => {
  it('passes predictor features through and evaluates drinkability against the explicit target year', async () => {
    const predictor = {
      modelVersion: 'onnx:predictor-v1',
      predict: vi.fn().mockReturnValue({
        drinkingWindowStart: 2024,
        drinkingWindowEnd: 2030,
        peakYear: 2027,
        confidence: 'high' as const,
        modelVersion: 'onnx:predictor-v1',
      }),
    };

    const useCase = new DrinkingWindowUseCase(predictor);
    const result = await useCase.check({
      vintage: 2020,
      grapePrimaryEnc: 1,
      regionEnc: 2,
      countryEnc: 3,
      body: 4,
      tannin: 5,
      acidity: 6,
      sweetness: 1,
      avgCriticProxyScore: 91,
      priorDrinkingWindowStart: 2024,
      priorDrinkingWindowEnd: 2031,
      priorDrinkingWindowModelVersion: 'snapshot:on-index',
      grapePrimary: 'Nebbiolo',
      grapes: ['Nebbiolo'],
      grapeFamily: 'Nebbiolo',
      producer: 'Giacomo Conterno',
      country: 'Italy',
      region: 'Piemonte',
      appellation: 'Barolo DOCG',
      regionHierarchy: ['Italy', 'Piemonte', 'Barolo'],
      wineType: 'red',
      style: 'structured red',
      classification: 'DOCG',
      oakTreatment: 'large oak cask',
      producerPrestige: 0.91,
      ratingAvg: 4.6,
      ratingsCount: 1287,
      reviewCount: 211,
      ratingDistribution: { '1': 2, '2': 10, '3': 115, '4': 540, '5': 620 },
      wineryRatingCount: 8240,
      priceUsd: 180,
      bottleSizeMl: 750,
      bottleSize: '750ml',
      closure: 'Cork',
      certifications: ['organic'],
      producerType: 'domaine',
      soilType: 'limestone',
      finishLength: 0.92,
      alcoholPct: 14.5,
      targetYear: 2027,
    });

    expect(predictor.predict).toHaveBeenCalledWith({
      vintage: 2020,
      grapePrimaryEnc: 1,
      regionEnc: 2,
      countryEnc: 3,
      body: 4,
      tannin: 5,
      acidity: 6,
      sweetness: 1,
      avgCriticProxyScore: 91,
      priorDrinkingWindowStart: 2024,
      priorDrinkingWindowEnd: 2031,
      priorDrinkingWindowModelVersion: 'snapshot:on-index',
      grapePrimary: 'Nebbiolo',
      grapes: ['Nebbiolo'],
      grapeFamily: 'Nebbiolo',
      producer: 'Giacomo Conterno',
      country: 'Italy',
      region: 'Piemonte',
      appellation: 'Barolo DOCG',
      regionHierarchy: ['Italy', 'Piemonte', 'Barolo'],
      wineType: 'red',
      style: 'structured red',
      classification: 'DOCG',
      oakTreatment: 'large oak cask',
      producerPrestige: 0.91,
      ratingAvg: 4.6,
      ratingsCount: 1287,
      reviewCount: 211,
      ratingDistribution: { '1': 2, '2': 10, '3': 115, '4': 540, '5': 620 },
      wineryRatingCount: 8240,
      priceUsd: 180,
      bottleSizeMl: 750,
      bottleSize: '750ml',
      closure: 'Cork',
      certifications: ['organic'],
      producerType: 'domaine',
      soilType: 'limestone',
      finishLength: 0.92,
      alcoholPct: 14.5,
    });
    expect(result).toEqual({
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2030,
      peakYear: 2027,
      currentlyDrinkable: true,
      confidence: 'high',
      evidenceLevel: 'learned',
      blockingEligible: true,
      modelVersion: 'onnx:predictor-v1',
    });
  });

  it('returns deterministic evidence for deterministic predictor model versions', async () => {
    const predictor = {
      modelVersion: 'deterministic:structural-slot-v2',
      predict: vi.fn().mockReturnValue({
        drinkingWindowStart: 2024,
        drinkingWindowEnd: 2030,
        peakYear: 2027,
        confidence: 'medium' as const,
        modelVersion: 'deterministic:structural-slot-v2',
      }),
    };

    const useCase = new DrinkingWindowUseCase(predictor);
    const result = await useCase.check({
      vintage: 2020,
      grapePrimaryEnc: 1,
      regionEnc: 2,
      countryEnc: 3,
      body: 4,
      tannin: 5,
      acidity: 6,
      sweetness: 1,
      avgCriticProxyScore: 91,
      targetYear: 2027,
    });

    expect(result.evidenceLevel).toBe('deterministic');
    expect(result.blockingEligible).toBe(true);
  });
});
