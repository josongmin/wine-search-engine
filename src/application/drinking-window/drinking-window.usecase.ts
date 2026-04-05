/**
 * Epic 15: Drinking Window Use Case
 *
 * Checks and predicts when a wine is drinkable/at peak quality.
 * Integrates with Vespa document data + ONNX model predictions.
 */

import type { DrinkingWindowPredictor } from '../../infrastructure/ml/drinking-window-predictor.js';
import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';

/**
 * Request to check drinking window for a wine.
 */
export interface DrinkingWindowCheckRequest {
  readonly vintage: number;
  readonly grapePrimaryEnc: number;
  readonly regionEnc: number;
  readonly countryEnc: number;
  readonly body: number;
  readonly tannin: number;
  readonly acidity: number;
  readonly sweetness: number;
  readonly avgCriticProxyScore: number;
  readonly targetYear?: number; // defaults to current year
}

/**
 * Drinking window check result.
 */
export class DrinkingWindowUseCase {
  constructor(private readonly predictor: DrinkingWindowPredictor) {}

  /**
   * Predicts drinking window for a wine and checks if currently drinkable.
   */
  check(request: DrinkingWindowCheckRequest): Promise<DrinkingWindowBlock> {
    const targetYear = request.targetYear ?? new Date().getFullYear();

    // Use predictor to get drinking window
    const prediction = this.predictor.predict({
      vintage: request.vintage,
      grapePrimaryEnc: request.grapePrimaryEnc,
      regionEnc: request.regionEnc,
      countryEnc: request.countryEnc,
      body: request.body,
      tannin: request.tannin,
      acidity: request.acidity,
      sweetness: request.sweetness,
      avgCriticProxyScore: request.avgCriticProxyScore,
    });

    return Promise.resolve({
      drinkingWindowStart: prediction.drinkingWindowStart,
      drinkingWindowEnd: prediction.drinkingWindowEnd,
      currentlyDrinkable:
        targetYear >= prediction.drinkingWindowStart &&
        targetYear <= prediction.drinkingWindowEnd,
      confidence: prediction.confidence,
      modelVersion: prediction.modelVersion,
    });
  }
}
