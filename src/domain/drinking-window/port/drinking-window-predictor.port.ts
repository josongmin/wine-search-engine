/**
 * Port for predicting a wine's drinking window.
 *
 * Application use cases depend on this contract, while infrastructure adapters
 * provide deterministic or learned runtime implementations.
 */

/**
 * Scale factor to convert Vespa [0,1] normalised sensory floats to the
 * predictor's [1–5 ordinal] scale. Apply to body/tannin/acidity/sweetness
 * before passing to DrinkingWindowInput.
 *
 * Source: drinking-window-predictor.ts feature encoding; LightGBM model was
 * trained on [1–5] ordinal labels per the ETL pipeline at ingest time.
 */
export const DRINKING_WINDOW_SENSORY_ORDINAL_SCALE = 5;

export interface DrinkingWindowInputRatingDistribution {
  readonly '1'?: number | undefined;
  readonly '2'?: number | undefined;
  readonly '3'?: number | undefined;
  readonly '4'?: number | undefined;
  readonly '5'?: number | undefined;
}

/**
 * Drinking-window predictor input.
 *
 * The encoded core features remain mandatory because both the legacy learned
 * predictor and the current deterministic runtime consume them. The wider
 * optional fields carry source-backed structural priors for deterministic /
 * hybrid drinking-window models.
 *
 * All sensory fields (body, tannin, acidity, sweetness) must be provided on
 * the [1–5 ordinal] scale — convert from Vespa [0,1] using
 * DRINKING_WINDOW_SENSORY_ORDINAL_SCALE before populating this struct.
 */
export interface DrinkingWindowInput {
  readonly vintage: number;
  readonly grapePrimaryEnc: number;
  readonly regionEnc: number;
  readonly countryEnc: number;
  /** Body [1–5 ordinal]. Absent when not indexed — predictor falls back to midpoint (2.0). */
  readonly body?: number | undefined;
  readonly tannin: number;
  readonly acidity: number;
  /** Sweetness [1–5 ordinal]. Absent when not indexed — predictor falls back to midpoint. */
  readonly sweetness?: number | undefined;
  readonly avgCriticProxyScore: number;
  readonly priorDrinkingWindowStart?: number | undefined;
  readonly priorDrinkingWindowEnd?: number | undefined;
  readonly priorDrinkingWindowModelVersion?: string | undefined;
  readonly grapePrimary?: string | undefined;
  readonly grapes?: readonly string[] | undefined;
  readonly grapeFamily?: string | undefined;
  readonly producer?: string | undefined;
  readonly country?: string | undefined;
  readonly region?: string | undefined;
  readonly appellation?: string | undefined;
  readonly regionHierarchy?: readonly string[] | undefined;
  readonly wineType?: string | undefined;
  readonly style?: string | undefined;
  readonly classification?: string | undefined;
  readonly oakTreatment?: string | undefined;
  readonly producerPrestige?: number | undefined;
  readonly ratingAvg?: number | undefined;
  readonly ratingsCount?: number | undefined;
  readonly reviewCount?: number | undefined;
  readonly ratingDistribution?: DrinkingWindowInputRatingDistribution | undefined;
  readonly wineryRatingCount?: number | undefined;
  readonly priceUsd?: number | undefined;
  readonly bottleSizeMl?: number | undefined;
  readonly bottleSize?: string | undefined;
  readonly closure?: string | undefined;
  readonly certifications?: readonly string[] | undefined;
  readonly producerType?: string | undefined;
  readonly soilType?: string | undefined;
  readonly finishLength?: number | undefined;
  readonly alcoholPct?: number | undefined;
}

/**
 * Drinking-window prediction output.
 */
export interface DrinkingWindowPrediction {
  readonly drinkingWindowStart: number;
  readonly drinkingWindowEnd: number;
  readonly peakYear: number;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly modelVersion: string;
}

/**
 * Minimal predictor contract consumed by the drinking-window use case.
 */
export interface DrinkingWindowPredictorPort {
  readonly modelVersion: string;
  predict(input: DrinkingWindowInput): DrinkingWindowPrediction | Promise<DrinkingWindowPrediction>;
}
