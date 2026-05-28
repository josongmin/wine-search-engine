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
import {
  inferDrinkingWindowBlockingEligibility,
  inferDrinkingWindowEvidenceLevel,
} from '../search/drinking-window-confidence.js';
import { projectDrinkingWindowBlock } from './drinking-window-block-projection.js';

/**
 * Request to check drinking window for a wine.
 */
export class DrinkingWindowUseCase implements DrinkingWindowUseCasePort {
  constructor(private readonly predictor: DrinkingWindowPredictorPort) {}

  /**
   * Predicts drinking window for a wine and checks if currently drinkable.
   */
  async check(request: DrinkingWindowCheckRequest): Promise<DrinkingWindowBlock> {
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
      priorDrinkingWindowStart: request.priorDrinkingWindowStart,
      priorDrinkingWindowEnd: request.priorDrinkingWindowEnd,
      priorDrinkingWindowModelVersion: request.priorDrinkingWindowModelVersion,
      grapePrimary: request.grapePrimary,
      grapes: request.grapes,
      grapeFamily: request.grapeFamily,
      producer: request.producer,
      country: request.country,
      region: request.region,
      appellation: request.appellation,
      regionHierarchy: request.regionHierarchy,
      wineType: request.wineType,
      style: request.style,
      classification: request.classification,
      oakTreatment: request.oakTreatment,
      producerPrestige: request.producerPrestige,
      ratingAvg: request.ratingAvg,
      ratingsCount: request.ratingsCount,
      reviewCount: request.reviewCount,
      ratingDistribution: request.ratingDistribution,
      wineryRatingCount: request.wineryRatingCount,
      priceUsd: request.priceUsd,
      bottleSizeMl: request.bottleSizeMl,
      bottleSize: request.bottleSize,
      closure: request.closure,
      certifications: request.certifications,
      producerType: request.producerType,
      soilType: request.soilType,
      finishLength: request.finishLength,
      alcoholPct: request.alcoholPct,
    };
    const prediction = await this.predictor.predict(predictionInput);
    const projected = projectDrinkingWindowBlock({
      drinkingWindowStart: prediction.drinkingWindowStart,
      drinkingWindowEnd: prediction.drinkingWindowEnd,
      peakYear: prediction.peakYear,
      currentlyDrinkable: false,
      confidence: prediction.confidence,
      evidenceLevel: inferDrinkingWindowEvidenceLevel(prediction.modelVersion),
      blockingEligible: inferDrinkingWindowBlockingEligibility(prediction.modelVersion),
      modelVersion: prediction.modelVersion,
    }, request.targetYear);
    if (projected === undefined) {
      throw new Error(
        `DrinkingWindowUseCase: predictor emitted non-projectable window `
        + `(start=${String(prediction.drinkingWindowStart)}, `
        + `end=${String(prediction.drinkingWindowEnd)}, `
        + `peak=${String(prediction.peakYear)})`,
      );
    }
    return projected;
  }
}
