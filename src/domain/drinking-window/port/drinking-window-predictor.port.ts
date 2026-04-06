/**
 * Port for predicting a wine's drinking window.
 *
 * Application use cases depend on this contract, while infrastructure adapters
 * provide the concrete ONNX / heuristic implementation.
 */

/**
 * Encoded feature vector used by the drinking-window predictor.
 */
export interface DrinkingWindowInput {
  readonly vintage: number;
  readonly grapePrimaryEnc: number;
  readonly regionEnc: number;
  readonly countryEnc: number;
  readonly body: number;
  readonly tannin: number;
  readonly acidity: number;
  readonly sweetness: number;
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
  predict(input: DrinkingWindowInput): DrinkingWindowPrediction;
}
