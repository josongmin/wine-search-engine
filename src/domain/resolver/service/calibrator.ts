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
   * Calibrates the raw top-1 and (optionally) top-2 scores into a
   * {@link CalibratedResolutionScore}.
   *
   * C2 (fail-loud): the runner-up is optional. When absent, the returned
   * `top2CalibratedScore` and `calibratedGap` are `undefined`; callers must
   * branch on `hasRunnerUp` rather than treating a missing runner-up as a
   * synthetic 0.
   *
   * @param rawScores.top1 - Raw top-1 score (required; must be finite).
   * @param rawScores.top2 - Raw top-2 score. `undefined` when there is no
   *                        runner-up. Must be finite when provided.
   * @param rawScores.candidateCount - Number of candidates actually scored.
   * @param queryClass - Query class for parameter lookup.
   */
  async calibrate(
    rawScores: {
      readonly top1: number;
      readonly top2: number | undefined;
      readonly candidateCount: number;
    },
    queryClass: QueryClass,
  ): Promise<CalibratedResolutionScore> {
    if (!Number.isFinite(rawScores.top1)) {
      throw new Error(
        `Calibrator.calibrate: top1 raw score is not finite (got ${String(rawScores.top1)}); ` +
        'resolver must not surface a non-finite score to the calibrator. This is a contract violation.',
      );
    }
    if (rawScores.candidateCount < 1) {
      throw new Error(
        `Calibrator.calibrate: candidateCount must be >= 1 when calibrate() is called (got ${rawScores.candidateCount}).`,
      );
    }
    if (rawScores.top2 !== undefined && !Number.isFinite(rawScores.top2)) {
      throw new Error(
        `Calibrator.calibrate: top2 raw score is not finite (got ${String(rawScores.top2)}); ` +
        'pass undefined for absent runner-up, never NaN/Infinity.',
      );
    }
    const hasRunnerUp = rawScores.top2 !== undefined;

    const params = await this.loadParams(queryClass);
    // Normalize only when the default isotonic fallback is used. The gap
    // between top1 and top2 must be preserved under the same monotonic
    // transform so the calibrated gap is comparable.
    const { normalizedTop1, normalizedTop2 } = this.isDefaultFallbackParams(params)
      ? this.normalizeFallbackRawScores(rawScores.top1, rawScores.top2)
      : { normalizedTop1: rawScores.top1, normalizedTop2: rawScores.top2 };

    const top1Calibrated = this.applyCalibration(normalizedTop1, params);
    const top2Calibrated = normalizedTop2 !== undefined
      ? this.applyCalibration(normalizedTop2, params)
      : undefined;

    const calibratedGap = top2Calibrated !== undefined
      ? top1Calibrated - top2Calibrated
      : undefined;

    return {
      top1CalibratedScore: top1Calibrated,
      hasRunnerUp,
      candidateCount: rawScores.candidateCount,
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
   * exceeds 1.0 by scaling top1 (and optionally top2) with the same factor.
   * top2 stays `undefined` when there is no runner-up.
   */
  private normalizeFallbackRawScores(
    top1: number,
    top2: number | undefined,
  ): { readonly normalizedTop1: number; readonly normalizedTop2: number | undefined } {
    const factor = Math.max(1, top1);
    return {
      normalizedTop1: top1 / factor,
      normalizedTop2: top2 !== undefined ? top2 / factor : undefined,
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
        // Fix 6 (fail-loud): Platt scaling REQUIRES 'a' and 'b' params. Silent
        // fallback to identity (a=1, b=0) masked stored-params corruption as a
        // successfully-calibrated score. Throw instead so the calibrator caller
        // (resolver) surfaces it as degradation_reasons rather than serving a
        // decision made on uncalibrated state.
        const a = params.params['a'];
        const b = params.params['b'];
        if (a === undefined || b === undefined) {
          throw new Error(
            `Calibrator: Platt method requires 'a' and 'b' params, got ${JSON.stringify(Object.keys(params.params))}. ` +
            'Stored calibration params are corrupt or incomplete — refusing identity fallback.',
          );
        }
        return plattScaling(rawScore, a, b);
      }
      case 'temperature': {
        // Fix 6 (fail-loud): temperature method REQUIRES 'temperature' param.
        const temperature = params.params['temperature'];
        if (temperature === undefined) {
          throw new Error(
            `Calibrator: temperature method requires 'temperature' param, got ${JSON.stringify(Object.keys(params.params))}. ` +
            'Stored calibration params are corrupt or incomplete — refusing identity fallback.',
          );
        }
        if (!Number.isFinite(temperature) || temperature <= 0) {
          throw new Error(
            `Calibrator: temperature must be finite and > 0, got ${String(temperature)}. ` +
            'Stored calibration params are corrupt or invalid — refusing silent fallback.',
          );
        }
        // Temperature-scaled sigmoid: P(positive) = 1/(1+exp(-rawScore/T)).
        // The previous implementation built `[rawScore, 1-rawScore]` and ran
        // softmax over them, which capped the output at 0.731 for any
        // rawScore ≥ 1.0 — silently destroying precision for trivially
        // resolved candidates. A direct sigmoid preserves full dynamic range.
        const sigmoid = 1 / (1 + Math.exp(-rawScore / temperature));
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
      // Isotonic regression requires non-decreasing Y values; a Y-axis violation
      // indicates the stored model was not fitted with isotonic constraints and
      // would produce non-monotonic calibrated probabilities.
      if (i > 0 && y < prevY) {
        process.emitWarning(
          `IsotonicCalibrator: non-monotonic Y at index ${String(i)} (y=${String(y)} < prevY=${String(prevY)}); falling back to identity scaling.`,
          { type: 'CalibrationWarning', code: 'ISOTONIC_BREAKPOINT_NON_MONOTONIC_Y' },
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
