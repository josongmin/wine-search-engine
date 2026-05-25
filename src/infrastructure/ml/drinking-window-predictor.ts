import { access } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

/**
 * Epic 15, Step 15.3: Drinking Window Predictor (ONNX Runtime)
 *
 * Predicts wine drinking windows (when the wine is at peak quality).
 * Uses two independent LightGBM models trained on:
 *  - Grape, region, vintage, sensory attributes (body, tannin, acidity)
 *  - Critic proxy score (from Epic 12)
 *
 * Serves ONNX-exported LightGBM models via onnxruntime-node.
 * ONNX models must be loaded via load() before predict() is callable.
 */

/**
 * Initial model version sentinel before ONNX models are loaded.
 * load() replaces this with `onnx:<modelDir>` on success.
 */
const DRINKING_WINDOW_MODEL_VERSION = 'unloaded';

/** Sensory body midpoint default when optional body is absent (ONNX feature encoding). */
const SENSORY_BODY_MIDPOINT_DEFAULT = 2;
/** Sensory sweetness midpoint default when optional sweetness is absent (ONNX feature encoding). */
const SENSORY_SWEETNESS_MIDPOINT_DEFAULT = 3;

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
  return import('onnxruntime-node') as Promise<OrtModule>;
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
  /** Body [1–5 ordinal]. Optional — predictor falls back to structural midpoint when absent. */
  readonly body?: number | undefined;
  readonly tannin: number;
  readonly acidity: number;
  /** Sweetness [1–5 ordinal]. Optional — predictor falls back to structural midpoint when absent. */
  readonly sweetness?: number | undefined;
  readonly avgCriticProxyScore: number; // 80–100 (or 0 if absent)
}

/**
 * Drinking window prediction result.
 *
 * `confidenceScore` is the numeric counterpart to the enum `confidence`
 * (maturity-3 contract). The ONNX path lacks a calibrated probabilistic
 * head, so it emits the medium-band midpoint — see ONNX_CONFIDENCE_MIDPOINT
 * in predictWithOnnx.
 */
export interface DrinkingWindowPrediction {
  readonly drinkingWindowStart: number;   // year (drinking_window_start)
  readonly drinkingWindowEnd: number;     // year (drinking_window_end)
  readonly peakYear: number;              // estimated peak year (optional)
  readonly confidence: 'high' | 'medium' | 'low';
  /** Numeric confidence bound in [0, 1]; aligned with the enum confidence. */
  readonly confidenceScore: number;
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
  private currentModelVersion = DRINKING_WINDOW_MODEL_VERSION;
  private sessionStart?: OrtSession;
  private sessionEnd?: OrtSession;
  private tensorCtor?: OrtModule['Tensor'];
  /**
   * In-flight load promise. Concurrent load() calls share this so we never
   * end up with two pairs of sessions and a leaked first pair.
   */
  private loadPromise: Promise<void> | undefined;

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
   * Predicts drinking window via loaded ONNX models.
   * Throws if ONNX models have not been loaded via load().
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

    throw new Error(
      'DrinkingWindowPredictor: ONNX models not loaded. Call load() with a directory containing window_start.onnx and window_end.onnx.',
    );
  }

  private isOnnxReady(): boolean {
    return (
      this.sessionStart !== undefined &&
      this.sessionEnd !== undefined &&
      this.tensorCtor !== undefined
    );
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
      const value = first.data[0];
      if (!Number.isFinite(value)) {
        throw new Error(`DrinkingWindowPredictor ONNX output is not finite: ${String(value)}`);
      }
      return value;
    };

    const [startOffset, endOffset] = await Promise.all([
      runAsync(sessionStart, tensorStart),
      runAsync(sessionEnd, tensorEnd),
    ]);

    // Rule 28: NaN vintage propagates silently through all arithmetic.
    if (!Number.isFinite(input.vintage)) {
      throw new Error(`DrinkingWindowPredictor ONNX: vintage is not finite (got ${String(input.vintage)})`);
    }
    const drinkingWindowStart = Math.round(input.vintage + Math.max(0, startOffset));
    // Guarantee end > start regardless of model output sign/magnitude.
    // Math.max(startOffset + 1, endOffset) is insufficient when both offsets are
    // negative: e.g. startOffset=-10, endOffset=-5 → start=vintage, end=vintage-5
    // (INVARIANT VIOLATION). Clamp end to start+1.
    const drinkingWindowEnd = Math.max(
      drinkingWindowStart + 1,
      Math.round(input.vintage + endOffset),
    );
    const peakYear = Math.round(
      drinkingWindowStart + (drinkingWindowEnd - drinkingWindowStart) / 2,
    );

    // Rule 15: ONNX model emits no calibrated probability — surface the
    // medium-band midpoint so numeric consumers stay finite and aligned
    // with the legacy enum value. ONNX_CONFIDENCE_MIDPOINT = midpoint of
    // [CONFIDENCE_MEDIUM_THRESHOLD, CONFIDENCE_HIGH_THRESHOLD) = (0.5+0.75)/2.
    const ONNX_CONFIDENCE_MIDPOINT = 0.625;
    return {
      drinkingWindowStart,
      drinkingWindowEnd,
      peakYear,
      confidence: 'medium',
      confidenceScore: ONNX_CONFIDENCE_MIDPOINT,
      modelVersion: this.modelVersion,
    };
  }

  private toFeatureArray(input: DrinkingWindowInput): Float32Array {
    // body/sweetness are optional in the port — fall back to structural midpoint
    // so undefined values do not produce NaN features sent to the ONNX model.
    const body = input.body ?? SENSORY_BODY_MIDPOINT_DEFAULT;
    const sweetness = input.sweetness ?? SENSORY_SWEETNESS_MIDPOINT_DEFAULT;
    return new Float32Array([
      input.grapePrimaryEnc,
      input.regionEnc,
      input.countryEnc,
      input.vintage,
      body,
      input.tannin,
      input.acidity,
      sweetness,
      input.avgCriticProxyScore,
      input.tannin * input.acidity,
      body * input.tannin,
    ]);
  }
}
