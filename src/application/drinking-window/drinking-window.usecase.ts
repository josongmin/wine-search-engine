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
import type {
  DrinkingWindowCheckRequest,
  DrinkingWindowUseCasePort,
} from './port/drinking-window-usecase.port.js';

/**
 * Request to check drinking window for a wine.
 */
export class DrinkingWindowUseCase implements DrinkingWindowUseCasePort {
  constructor(private readonly predictor: DrinkingWindowPredictorPort) {}

  /**
   * Predicts drinking window for a wine and checks if currently drinkable.
   */
  check(request: DrinkingWindowCheckRequest): Promise<DrinkingWindowBlock> {
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
      peakYear: prediction.peakYear,
      currentlyDrinkable:
        request.targetYear >= prediction.drinkingWindowStart &&
        request.targetYear <= prediction.drinkingWindowEnd,
      confidence: prediction.confidence,
      modelVersion: prediction.modelVersion,
    });
  }
}
