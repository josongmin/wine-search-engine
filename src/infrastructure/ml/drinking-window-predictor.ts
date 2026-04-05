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
 * LightGBM-backed Drinking Window Predictor via ONNX Runtime.
 *
 * Expected ONNX model files:
 *  - {modelDir}/window_start.onnx — predicts (drinking_window_start - vintage)
 *  - {modelDir}/window_end.onnx — predicts (drinking_window_end - vintage)
 *
 * Features: [grape_enc, region_enc, country_enc, vintage, body, tannin, acidity, sweetness, critic_score,
 *            tannin×acidity, body×tannin]
 */
export class DrinkingWindowPredictor {
  private initialized = false;

  /**
   * Loads ONNX models from disk.
   * In production: const { InferenceSession } = await import('onnxruntime-node');
   */
  async load(modelDir: string): Promise<void> {
    try {
      // TODO: Uncomment when onnxruntime-node is available
      // const { InferenceSession } = await import('onnxruntime-node');
      // const sessionStart = await InferenceSession.create(`${modelDir}/window_start.onnx`);
      // const sessionEnd = await InferenceSession.create(`${modelDir}/window_end.onnx`);
      console.warn(
        `[DrinkingWindowPredictor] Loading models from ${modelDir} (stub mode)`,
      );
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load drinking window ONNX models from ${modelDir}: ${errorMsg}`,
      );
    }
    this.initialized = true;
  }

  /**
   * Predicts drinking window for a wine using LightGBM model.
   *
   * Real implementation: runs ONNX inference on feature array.
   * Stub implementation: uses feature-weighted heuristic.
   */
  predict(input: DrinkingWindowInput): DrinkingWindowPrediction {
    if (!this.initialized) {
      throw new Error('DrinkingWindowPredictor not loaded — call load() first');
    }

    // ─── Feature engineering ───────────────────────────────────────────
    const vintage = input.vintage;
    const body = input.body; // 1–5
    const tannin = input.tannin; // 1–5
    const acidity = input.acidity; // 1–5
    const criticScore = Math.max(0, input.avgCriticProxyScore); // 0–100

    // Interaction terms (for future ONNX model compatibility)
    const tanninAcidity = tannin * acidity;

    // ─── LightGBM prediction stub ───────────────────────────────────────
    // In production: featureArray → sessionStart.run() → offset
    // For now: weighted sum approximating LGB decision tree output

    const startOffsetRaw =
      tannin * 0.8 + acidity * 0.5 + (criticScore / 100) * 3 - body * 0.2;
    const endOffsetRaw =
      tannin * 2.0 +
      acidity * 1.2 +
      (criticScore / 100) * 5 +
      tanninAcidity * 0.05 -
      body * 0.3;

    // Clamp to reasonable ranges
    const startOffset = Math.max(0, Math.min(15, startOffsetRaw));
    const endOffset = Math.max(startOffset + 5, Math.min(50, endOffsetRaw));

    const drinkingWindowStart = Math.round(vintage + startOffset);
    const drinkingWindowEnd = Math.round(vintage + endOffset);
    const peakYear = Math.round(
      vintage + startOffset + (endOffset - startOffset) / 2,
    );

    // ─── Confidence calibration ─────────────────────────────────────────
    let confidence: 'high' | 'medium' | 'low' = 'medium';

    // High confidence: structured wines with good critic scores
    if (criticScore >= 90 && (tannin >= 3 || acidity >= 4)) {
      confidence = 'high';
    }
    // Low confidence: light wines or low scores
    else if (criticScore < 75 || (tannin < 1.5 && body < 2)) {
      confidence = 'low';
    }

    return {
      drinkingWindowStart,
      drinkingWindowEnd,
      peakYear,
      confidence,
      modelVersion: DRINKING_WINDOW_MODEL_VERSION,
    };
  }
}
