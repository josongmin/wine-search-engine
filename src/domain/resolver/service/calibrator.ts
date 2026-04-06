import type { QueryClass } from '../../shared/types/index.js';
import { plattScaling, temperatureScaling } from '../../shared/utils/calibration.js';
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
        // Temperature scaling requires at least two logits; use raw score
        // and its complement as a binary distribution.
        const logits = [rawScore, 1.0 - rawScore];
        const calibrated = temperatureScaling(logits, temperature);
        // Return the probability of the positive class (index 0).
        return calibrated[0] ?? 0.5;
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
      return Math.max(0, Math.min(1, rawScore));
    }

    // Simple linear interpolation between adjacent breakpoints.
    // Breakpoints are stored as x_0, y_0, x_1, y_1, ...
    let prevX = 0;
    let prevY = 0;
    for (let i = 0; i < breakpointCount; i++) {
      const x = params.params[`x_${String(i)}`] ?? 0;
      const y = params.params[`y_${String(i)}`] ?? 0;
      if (rawScore <= x) {
        if (x === prevX) {
          return y;
        }
        const t = (rawScore - prevX) / (x - prevX);
        return prevY + t * (y - prevY);
      }
      prevX = x;
      prevY = y;
    }

    return prevY;
  }
}
