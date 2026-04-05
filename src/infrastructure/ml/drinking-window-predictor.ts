/**
 * Epic 15, Step 15.3: Drinking Window Predictor (ONNX Runtime)
 *
 * Predicts wine drinking windows (when the wine is at peak quality).
 * Uses two independent LightGBM models trained on:
 *  - Grape, region, vintage, sensory attributes (body, tannin, acidity)
 *  - Critic proxy score (from Epic 12)
 *
 * Serves ONNX-exported LightGBM models via onnxruntime-node.
 */

/**
 * Drinking window model version.
 * Format: v{major}.{minor}-enc{YYYYMMDD}
 * enc version pins the label encoders (grape, region, country).
 */
export const DRINKING_WINDOW_MODEL_VERSION = 'v1.0-enc20260405';

/**
 * Feature input for drinking window prediction.
 * All fields should be pre-encoded (label-encoded for categorical, normalized for numeric).
 */
export interface DrinkingWindowInput {
  readonly vintage: number;
  readonly grapePrimaryEnc: number;  // 0–N, OOV → 999
  readonly regionEnc: number;
  readonly countryEnc: number;
  readonly body: number;             // 1–5 (ordinal)
  readonly tannin: number;
  readonly acidity: number;
  readonly sweetness: number;
  readonly avgCriticProxyScore: number; // 80–100 (or 0 if absent)
}

/**
 * Drinking window prediction result.
 */
export interface DrinkingWindowPrediction {
  readonly drinkingWindowStart: number;   // year (drinking_window_start)
  readonly drinkingWindowEnd: number;     // year (drinking_window_end)
  readonly peakYear: number;              // estimated peak year (optional)
  readonly confidence: 'high' | 'medium' | 'low';
  readonly modelVersion: string;
}

/**
 * Mock implementation of DrinkingWindowPredictor.
 * In production, this would load ONNX models from disk and use InferenceSession.
 *
 * For now: simple heuristic-based prediction based on grape/tannin.
 */
export class DrinkingWindowPredictor {
  private initialized = false;

  async load(_modelDir: string): Promise<void> {
    // TODO: Load ONNX models
    // this.sessionStart = await InferenceSession.create(`${modelDir}/window_start.onnx`);
    // this.sessionEnd = await InferenceSession.create(`${modelDir}/window_end.onnx`);
    this.initialized = true;
  }

  /**
   * Predicts drinking window for a wine.
   *
   * Heuristic: high-tannin wines age longer, high-acidity wines are more age-worthy.
   * Formula (placeholder):
   *  - window_start_offset = (tannin + acidity) / 2 (years to wait from vintage)
   *  - window_end_offset = window_start_offset + 10 + (tannin * 2)
   */
  predict(input: DrinkingWindowInput): DrinkingWindowPrediction {
    if (!this.initialized) {
      throw new Error('DrinkingWindowPredictor not loaded');
    }

    // Heuristic-based prediction (placeholder)
    const waitYears = Math.max(0, (input.tannin + input.acidity) / 2);
    const ageYears = 10 + input.tannin * 2;

    const startYear = Math.round(input.vintage + waitYears);
    const endYear = Math.round(startYear + ageYears);
    const peakYear = Math.round(input.vintage + waitYears + ageYears / 2);

    // Confidence depends on critic score and body
    let confidence: 'high' | 'medium' | 'low' = 'medium';
    if (input.avgCriticProxyScore > 90 && input.tannin >= 3) {
      confidence = 'high';
    } else if (input.avgCriticProxyScore < 80 || input.tannin < 2) {
      confidence = 'low';
    }

    return {
      drinkingWindowStart: startYear,
      drinkingWindowEnd: endYear,
      peakYear,
      confidence,
      modelVersion: DRINKING_WINDOW_MODEL_VERSION,
    };
  }
}
