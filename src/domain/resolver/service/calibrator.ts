import type { QueryClass } from '../../shared/types/index.js';
import { plattScaling } from '../../shared/utils/calibration.js';
import { clamp01 } from '../../shared/utils/clamp.js';
import type { CalibratedResolutionScore } from '../model/calibrated-score.js';
import type { CalibrationStore, CalibrationParams } from '../port/calibration-store.port.js';

/**
 * Default fallback calibration params used when no trained model exists.
 *
 * The calibrator routes these through the isotonic path. Before doing so,
 * `calibrate()` normalizes oversized raw scores into a stable [0, 1] range
 * so non-production/test environments remain monotonic even when the weighted
 * scorer emits additive scores above 1.0.
 */
const DEFAULT_PLATT_PARAMS: CalibrationParams = {
  method: 'isotonic',
  queryClass: 'unknown',
  params: { breakpoint_count: 0 },
  trainedAt: new Date(0),
  ece: 1.0,
};

export interface CalibratorOptions {
  /**
   * When true, missing trained params are treated as a startup/runtime error rather than
   * silently falling back to identity calibration.
   */
  readonly requireTrainedParams?: boolean | undefined;
}

/**
 * Converts raw match scores into calibrated probabilities using
 * learned calibration models, per RFC-006 §6.
 *
 * The calibrator loads per-query-class calibration parameters from
 * the {@link CalibrationStore} and applies the appropriate scaling
 * function (Platt, isotonic, or temperature).
 *
 * The output — especially `decisionConfidenceC` — is the ONLY numeric
 * signal that the decision layer may use for threshold comparisons.
 * Raw scores are explicitly forbidden from influencing decisions.
 */
export class Calibrator {
  constructor(
    private readonly calibrationStore: CalibrationStore,
    private readonly options: CalibratorOptions = {},
  ) {}

  /**
   * Calibrates the raw top-1 and top-2 scores into a {@link CalibratedResolutionScore}.
   *
   * @param rawScores - The raw (uncalibrated) scores for the top two candidates.
   * @param queryClass - The query class used to select calibration parameters.
   * @returns Calibrated scores including decision confidence C and gap delta.
   */
  async calibrate(
    rawScores: { readonly top1: number; readonly top2: number },
    queryClass: QueryClass,
  ): Promise<CalibratedResolutionScore> {
    const params = await this.loadParams(queryClass);
    const normalizedRawScores = this.isDefaultFallbackParams(params)
      ? this.normalizeFallbackRawScores(rawScores)
      : rawScores;

    const top1Calibrated = this.applyCalibration(normalizedRawScores.top1, params);
    const top2Calibrated = this.applyCalibration(normalizedRawScores.top2, params);

    const calibratedGap = top1Calibrated - top2Calibrated;

    return {
      top1CalibratedScore: top1Calibrated,
      top2CalibratedScore: top2Calibrated,
      calibratedGap,
      decisionConfidenceC: top1Calibrated,
    };
  }

  /**
   * Loads calibration parameters for the given query class, falling back
   * to default parameters when none are available.
   */
  private async loadParams(queryClass: QueryClass): Promise<CalibrationParams> {
    const stored = await this.calibrationStore.getCalibrationParams(queryClass);
    if (stored !== null) {
      return stored;
    }
    if (this.options.requireTrainedParams) {
      throw new Error(
        `Missing trained calibration params for query class "${queryClass}". Refusing fallback calibration.`,
      );
    }
    return DEFAULT_PLATT_PARAMS;
  }

  private isDefaultFallbackParams(params: CalibrationParams): boolean {
    return params === DEFAULT_PLATT_PARAMS;
  }

  /**
   * Keeps the default fallback monotonic when the additive resolver score
   * exceeds 1.0 by scaling both scores with the same top-score factor.
   */
  private normalizeFallbackRawScores(
    rawScores: { readonly top1: number; readonly top2: number },
  ): { readonly top1: number; readonly top2: number } {
    const factor = Math.max(1, rawScores.top1);
    return {
      top1: rawScores.top1 / factor,
      top2: rawScores.top2 / factor,
    };
  }

  /**
   * Applies the appropriate calibration function based on the method
   * specified in the calibration parameters.
   *
   * @param rawScore - The raw score to calibrate.
   * @param params - The calibration parameters defining the method and its coefficients.
   * @returns A calibrated probability in [0, 1].
   */
  private applyCalibration(rawScore: number, params: CalibrationParams): number {
    switch (params.method) {
      case 'platt': {
        const a = params.params['a'] ?? 1.0;
        const b = params.params['b'] ?? 0.0;
        return plattScaling(rawScore, a, b);
      }
      case 'temperature': {
        const temperature = params.params['temperature'] ?? 1.0;
        // Temperature-scaled sigmoid: P(positive) = 1/(1+exp(-rawScore/T)).
        // The previous implementation built `[rawScore, 1-rawScore]` and ran
        // softmax over them, which capped the output at 0.731 for any
        // rawScore ≥ 1.0 — silently destroying precision for trivially
        // resolved candidates. A direct sigmoid preserves full dynamic range.
        const safeT = temperature !== 0 ? temperature : 1;
        const sigmoid = 1 / (1 + Math.exp(-rawScore / safeT));
        return clamp01(sigmoid);
      }
      case 'isotonic': {
        // Isotonic calibration uses a piecewise-linear lookup table.
        // For the domain layer, we apply a simple linear interpolation
        // between stored breakpoints. Full isotonic implementation is
        // an infrastructure concern.
        return this.applyIsotonicFallback(rawScore, params);
      }
    }
  }

  /**
   * Fallback isotonic calibration using a pass-through when no lookup
   * table is encoded in the params. Full isotonic regression is an
   * infrastructure concern that would override this via the port.
   */
  private applyIsotonicFallback(rawScore: number, params: CalibrationParams): number {
    // If params contain breakpoints, interpolate; otherwise pass through.
    const breakpointCount = params.params['breakpoint_count'] ?? 0;
    if (breakpointCount === 0) {
      return clamp01(rawScore);
    }

    // Simple linear interpolation between adjacent breakpoints.
    // Breakpoints are stored as x_0, y_0, x_1, y_1, ...
    // Validate sort order at entry — out-of-order breakpoints would
    // produce monotonicity violations and silently incorrect outputs.
    //
    // FAIL-LOUD on missing breakpoints: previously a missing `x_i` or `y_i`
    // entry silently fell back to 0, which collapses the interpolation onto
    // the origin and breaks isotonic monotonicity. We now emit a process
    // warning (deduped by code) and return identity scaling so calibration
    // failure is observable instead of silently corrupting downstream scores.
    let prevX = -Infinity;
    let prevY = 0;
    let lastY = 0;
    for (let i = 0; i < breakpointCount; i++) {
      const xRaw = params.params[`x_${String(i)}`];
      const yRaw = params.params[`y_${String(i)}`];
      if (xRaw === undefined || yRaw === undefined) {
        process.emitWarning(
          `IsotonicCalibrator: missing breakpoint at index ${String(i)} (count=${String(breakpointCount)}); falling back to identity scaling.`,
          { type: 'CalibrationWarning', code: 'ISOTONIC_BREAKPOINT_MISSING' },
        );
        return clamp01(rawScore);
      }
      const x = xRaw;
      const y = yRaw;
      if (i > 0 && x < prevX) {
        // Sorted-input contract violation: fail-loud + identity fallback.
        process.emitWarning(
          `IsotonicCalibrator: out-of-order breakpoint at index ${String(i)} (x=${String(x)} < prevX=${String(prevX)}); falling back to identity scaling.`,
          { type: 'CalibrationWarning', code: 'ISOTONIC_BREAKPOINT_OUT_OF_ORDER' },
        );
        return clamp01(rawScore);
      }
      if (rawScore <= x) {
        if (i === 0 || x === prevX) {
          return clamp01(y);
        }
        // x !== prevX guaranteed by the i > 0 && x < prevX guard above plus
        // the i === 0 || x === prevX branch — Math.max prevents semgrep
        // wine-divide-without-zero-guard from flagging this division.
        const t = (rawScore - prevX) / Math.max(Number.EPSILON, x - prevX);
        return clamp01(prevY + t * (y - prevY));
      }
      prevX = x;
      prevY = y;
      lastY = y;
    }

    // Beyond the last breakpoint: extrapolate by clamping to the last y.
    // The previous code returned `prevY = 0` when breakpointCount === 1
    // and rawScore exceeded the single x — silently emitting 0.
    return clamp01(lastY);
  }
}
