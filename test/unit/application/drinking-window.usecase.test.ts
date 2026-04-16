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

  it('returns undefined evidence for non-ONNX model versions', async () => {
    const predictor = {
      modelVersion: 'unloaded',
      predict: vi.fn().mockReturnValue({
        drinkingWindowStart: 2024,
        drinkingWindowEnd: 2030,
        peakYear: 2027,
        confidence: 'low' as const,
        modelVersion: 'unloaded',
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

    expect(result.evidenceLevel).toBeUndefined();
    expect(result.blockingEligible).toBe(false);
  });
});
