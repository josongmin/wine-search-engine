import { access } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapLogger } from '../../config/bootstrap-logger.js';

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
export const DRINKING_WINDOW_MODEL_VERSION = 'heuristic-v1.0-enc20260405';

/** Heuristic window predictor: baseline years before structure/critic bonuses. */
const HEURISTIC_BASE_WINDOW_YEARS = 3;
/** Sensory axes are centered at this 1–5 scale midpoint. */
const HEURISTIC_STRUCTURE_CENTER = 2;
const HEURISTIC_BODY_TANNIN_EXTENSION_WEIGHT = 1.5;
const HEURISTIC_ACIDITY_EXTENSION_WEIGHT = 1.0;
const HEURISTIC_CRITIC_SCORE_ELITE = 95;
const HEURISTIC_CRITIC_BONUS_ELITE = 5;
const HEURISTIC_CRITIC_SCORE_HIGH = 90;
const HEURISTIC_CRITIC_BONUS_HIGH = 3;
const HEURISTIC_CRITIC_SCORE_GOOD = 85;
const HEURISTIC_CRITIC_BONUS_GOOD = 1;
const HEURISTIC_SWEETNESS_STRUCTURAL_MID = 3;
const HEURISTIC_SWEETNESS_EXTENSION_WEIGHT = 1.5;
const HEURISTIC_TOTAL_WINDOW_MIN_YEARS = 3;
const HEURISTIC_TOTAL_WINDOW_MAX_YEARS = 25;
const HEURISTIC_VINTAGE_DRINKING_START_OFFSET = 2;
const HEURISTIC_MEDIUM_CONFIDENCE_CRITIC_FLOOR = 90;
const HEURISTIC_MEDIUM_CONFIDENCE_TANNIN_FLOOR = 3;
const HEURISTIC_MEDIUM_CONFIDENCE_ACIDITY_FLOOR = 4;

type OrtTensor = {
  readonly data: Float32Array;
};

type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  runSync?: ((feeds: Record<string, unknown>) => Record<string, OrtTensor>) | undefined;
};

type OrtModule = {
  InferenceSession: {
    create(modelPath: string): Promise<OrtSession>;
  };
  Tensor: new (
    type: string,
    data: Float32Array,
    dims: readonly number[],
  ) => unknown;
};

async function loadOrtModule(): Promise<OrtModule> {
  const moduleName = 'onnxruntime-node';
  return import(moduleName) as Promise<OrtModule>;
}

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
 * When `allowHeuristicFallback` is false, {@link DrinkingWindowPredictor.predict}
 * requires successful {@link DrinkingWindowPredictor.load} (ONNX only — no silent rule-based path).
 */
export interface DrinkingWindowPredictorOptions {
  readonly allowHeuristicFallback?: boolean;
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
  private currentModelVersion = DRINKING_WINDOW_MODEL_VERSION;
  private sessionStart?: OrtSession;
  private sessionEnd?: OrtSession;
  private tensorCtor?: OrtModule['Tensor'];
  private readonly allowHeuristicFallback: boolean;
  /**
   * In-flight load promise. Concurrent load() calls share this so we never
   * end up with two pairs of sessions and a leaked first pair.
   */
  private loadPromise: Promise<void> | undefined;

  constructor(options?: DrinkingWindowPredictorOptions) {
    this.allowHeuristicFallback = options?.allowHeuristicFallback ?? true;
  }

  get modelVersion(): string {
    return this.currentModelVersion;
  }

  /**
   * Loads ONNX sessions from `window_start.onnx` and `window_end.onnx` under `modelDir`.
   * Idempotent under concurrent calls — multiple awaiters share one load.
   */
  async load(modelDir: string): Promise<void> {
    if (this.loadPromise !== undefined) return this.loadPromise;
    this.loadPromise = (async () => {
      const startPath = path.join(modelDir, 'window_start.onnx');
      const endPath = path.join(modelDir, 'window_end.onnx');

      await access(startPath);
      await access(endPath);

      const ort = await loadOrtModule();
      // Build a local triple, then assign atomically. Without this, a
      // concurrent predict() arriving between sessionStart= and tensorCtor=
      // would observe a partially-loaded predictor (`isOnnxReady()` may be
      // true while only some fields are set).
      const newStart = await ort.InferenceSession.create(startPath);
      let newEnd: OrtSession;
      try {
        newEnd = await ort.InferenceSession.create(endPath);
      } catch (err) {
        // Release the start session if end load fails — otherwise we leak.
        const releasable = newStart as unknown as { release?: () => Promise<void> };
        if (typeof releasable.release === 'function') {
          await releasable.release().catch(() => undefined);
        }
        throw err;
      }
      // Release any previously-loaded sessions before swapping in new ones.
      const oldStart = this.sessionStart as unknown as { release?: () => Promise<void> } | undefined;
      const oldEnd = this.sessionEnd as unknown as { release?: () => Promise<void> } | undefined;
      this.sessionStart = newStart;
      this.sessionEnd = newEnd;
      this.tensorCtor = ort.Tensor;
      this.currentModelVersion = `onnx:${path.basename(modelDir)}`;
      if (typeof oldStart?.release === 'function') {
        await oldStart.release().catch(() => undefined);
      }
      if (typeof oldEnd?.release === 'function') {
        await oldEnd.release().catch(() => undefined);
      }
    })();
    try {
      await this.loadPromise;
    } catch (err) {
      // Clear so a future call can retry — without this, a transient failure
      // permanently locks the predictor into a bad state.
      this.loadPromise = undefined;
      throw err;
    }
  }

  /**
   * Predicts drinking window: ONNX when loaded; otherwise rule-based heuristic
   * if {@link DrinkingWindowPredictorOptions.allowHeuristicFallback} is true (default).
   */
  async predict(input: DrinkingWindowInput): Promise<DrinkingWindowPrediction> {
    if (this.isOnnxReady()) {
      return this.predictWithOnnx(
        input,
        this.sessionStart!,
        this.sessionEnd!,
        this.tensorCtor!,
      );
    }

    if (!this.allowHeuristicFallback) {
      throw new Error(
        'DrinkingWindowPredictor: ONNX required (allowHeuristicFallback=false). Load window_start.onnx and window_end.onnx via load().',
      );
    }

    return this.predictHeuristic(input);
  }

  private isOnnxReady(): boolean {
    return (
      this.sessionStart !== undefined &&
      this.sessionEnd !== undefined &&
      this.tensorCtor !== undefined
    );
  }

  private predictHeuristic(input: DrinkingWindowInput): DrinkingWindowPrediction {
    const vintage = input.vintage;
    const body = input.body;
    const tannin = input.tannin;
    const acidity = input.acidity;
    const score = Math.max(0, input.avgCriticProxyScore);

    const baseWindow = HEURISTIC_BASE_WINDOW_YEARS;
    const bodyBonus = Math.max(
      0,
      (body - HEURISTIC_STRUCTURE_CENTER) * HEURISTIC_BODY_TANNIN_EXTENSION_WEIGHT,
    );
    const tanninBonus = Math.max(
      0,
      (tannin - HEURISTIC_STRUCTURE_CENTER) * HEURISTIC_BODY_TANNIN_EXTENSION_WEIGHT,
    );
    const acidityBonus = Math.max(
      0,
      (acidity - HEURISTIC_STRUCTURE_CENTER) * HEURISTIC_ACIDITY_EXTENSION_WEIGHT,
    );
    const criticBonus =
      score >= HEURISTIC_CRITIC_SCORE_ELITE
        ? HEURISTIC_CRITIC_BONUS_ELITE
        : score >= HEURISTIC_CRITIC_SCORE_HIGH
          ? HEURISTIC_CRITIC_BONUS_HIGH
          : score >= HEURISTIC_CRITIC_SCORE_GOOD
            ? HEURISTIC_CRITIC_BONUS_GOOD
            : 0;
    // Sweetness above the structural midpoint extends aging potential (preservative effect).
    const sweetnessBonus = Math.max(
      0,
      (input.sweetness - HEURISTIC_SWEETNESS_STRUCTURAL_MID) * HEURISTIC_SWEETNESS_EXTENSION_WEIGHT,
    );

    // Floor totalWindow so end > start always holds, even when all
    // bonuses are 0 (light wine, low score). Without this floor, vintage=2024
    // with totalWindow=1 produced start=2026 > end=2025 (invariant violation).
    const totalWindow = Math.max(
      HEURISTIC_TOTAL_WINDOW_MIN_YEARS,
      Math.min(
        HEURISTIC_TOTAL_WINDOW_MAX_YEARS,
        baseWindow + bodyBonus + tanninBonus + acidityBonus + criticBonus + sweetnessBonus,
      ),
    );

    const drinkingWindowStart = vintage + HEURISTIC_VINTAGE_DRINKING_START_OFFSET;
    const drinkingWindowEnd = Math.max(
      drinkingWindowStart + 1,
      Math.round(vintage + totalWindow),
    );
    const peakYear = Math.round(
      drinkingWindowStart + (drinkingWindowEnd - drinkingWindowStart) / 2,
    );

    let confidence: 'high' | 'medium' | 'low' = 'low';

    if (
      score >= HEURISTIC_MEDIUM_CONFIDENCE_CRITIC_FLOOR
      && (
        tannin >= HEURISTIC_MEDIUM_CONFIDENCE_TANNIN_FLOOR
        || acidity >= HEURISTIC_MEDIUM_CONFIDENCE_ACIDITY_FLOOR
      )
    ) {
      confidence = 'medium';
    }

    return {
      drinkingWindowStart,
      drinkingWindowEnd,
      peakYear,
      confidence,
      modelVersion: this.modelVersion,
    };
  }

  private async predictWithOnnx(
    input: DrinkingWindowInput,
    sessionStart: OrtSession,
    sessionEnd: OrtSession,
    TensorCtor: OrtModule['Tensor'],
  ): Promise<DrinkingWindowPrediction> {
    const features = this.toFeatureArray(input);
    // Build TWO distinct tensors. Sharing one Tensor instance across two
    // concurrent sessions runs causes data races inside the ORT CPU
    // provider, which has caused corrupted outputs in the field. The
    // input is tiny (11 floats), so duplicating is essentially free.
    const tensorStart = new TensorCtor('float32', new Float32Array(features), [1, features.length]);
    const tensorEnd = new TensorCtor('float32', new Float32Array(features), [1, features.length]);

    const ONNX_SLOW_INFERENCE_WARN_MS = 500;

    const runAsync = async (session: OrtSession, tensor: typeof tensorStart): Promise<number> => {
      const t0 = performance.now();
      const result = await session.run({ input: tensor });
      const elapsed = performance.now() - t0;
      if (elapsed > ONNX_SLOW_INFERENCE_WARN_MS) {
        bootstrapLogger.warn(
          { elapsedMs: Math.round(elapsed), modelVersion: this.modelVersion },
          '[DrinkingWindowPredictor] ONNX inference exceeded slow threshold',
        );
      }
      const first = Object.values(result)[0];
      if (first === undefined || first.data[0] === undefined) {
        throw new Error('DrinkingWindowPredictor ONNX output was empty.');
      }
      return first.data[0];
    };

    const [startOffset, endOffset] = await Promise.all([
      runAsync(sessionStart, tensorStart),
      runAsync(sessionEnd, tensorEnd),
    ]);

    const drinkingWindowStart = Math.round(input.vintage + Math.max(0, startOffset));
    const drinkingWindowEnd = Math.round(
      input.vintage + Math.max(startOffset + 1, endOffset),
    );
    const peakYear = Math.round(
      drinkingWindowStart + (drinkingWindowEnd - drinkingWindowStart) / 2,
    );

    return {
      drinkingWindowStart,
      drinkingWindowEnd,
      peakYear,
      confidence: 'medium',
      modelVersion: this.modelVersion,
    };
  }

  private toFeatureArray(input: DrinkingWindowInput): Float32Array {
    return new Float32Array([
      input.grapePrimaryEnc,
      input.regionEnc,
      input.countryEnc,
      input.vintage,
      input.body,
      input.tannin,
      input.acidity,
      input.sweetness,
      input.avgCriticProxyScore,
      input.tannin * input.acidity,
      input.body * input.tannin,
    ]);
  }
}
