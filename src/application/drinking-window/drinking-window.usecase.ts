/**
 * Epic 15: Drinking Window Use Case
 *
 * Checks and predicts when a wine is drinkable/at peak quality.
 */

import type { DrinkingWindowBlock } from '../../domain/response/model/result-item.js';
import type {
  DrinkingWindowInput,
  DrinkingWindowPredictorPort,
} from '../../domain/drinking-window/port/drinking-window-predictor.port.js';
import type { DrinkingWindowUseCasePort } from './port/drinking-window-usecase.port.js';

/**
 * Request to check drinking window for a wine.
 */
export class DrinkingWindowUseCase implements DrinkingWindowUseCasePort {
  constructor(private readonly predictor: DrinkingWindowPredictorPort) {}

  /**
   * Predicts drinking window for a wine and checks if currently drinkable.
   */
  check(request: {
    readonly vintage: number;
    readonly grapePrimaryEnc: number;
    readonly regionEnc: number;
    readonly countryEnc: number;
    readonly body: number;
    readonly tannin: number;
    readonly acidity: number;
    readonly sweetness: number;
    readonly avgCriticProxyScore: number;
    readonly targetYear?: number;
  }): Promise<DrinkingWindowBlock> {
    const targetYear = request.targetYear ?? new Date().getFullYear();

    // Use predictor to get drinking window
    const predictionInput: DrinkingWindowInput = {
      vintage: request.vintage,
      grapePrimaryEnc: request.grapePrimaryEnc,
      regionEnc: request.regionEnc,
      countryEnc: request.countryEnc,
      body: request.body,
      tannin: request.tannin,
      acidity: request.acidity,
      sweetness: request.sweetness,
      avgCriticProxyScore: request.avgCriticProxyScore,
    };
    const prediction = this.predictor.predict(predictionInput);

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
