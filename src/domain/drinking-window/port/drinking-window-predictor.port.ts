/**
 * Port for predicting a wine's drinking window.
 *
 * Application use cases depend on this contract, while infrastructure adapters
 * provide the concrete ONNX implementation.
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

/**
 * Encoded feature vector used by the drinking-window predictor.
 * All sensory fields (body, tannin, acidity, sweetness) must be provided
 * on the [1–5 ordinal] scale — convert from Vespa [0,1] using
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
