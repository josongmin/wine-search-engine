import type { QueryClass } from '../../shared/types/index.js';

/**
 * Parameters for a specific calibration method trained on historical
 * resolution data, per RFC-006 §6.
 */
export interface CalibrationParams {
  /** The calibration method used. */
  readonly method: 'platt' | 'isotonic' | 'temperature';

  /** The query class these parameters are trained for. */
  readonly queryClass: QueryClass;

  /**
   * Method-specific parameters.
   * - Platt: `{ a: number, b: number }`
   * - Temperature: `{ temperature: number }`
   * - Isotonic: implementation-specific lookup table encoding.
   */
  readonly params: Readonly<Record<string, number>>;

  /** When these parameters were last trained/fitted. */
  readonly trainedAt: Date;

  /** Expected calibration error (ECE) measured at training time, in [0, 1]. */
  readonly ece: number;

  /**
   * Timestamp the model was last fitted by the nightly auto-pipeline (P0.1).
   *
   * Distinct from `trainedAt`: `fittedAt` is only populated by the nightly
   * `scripts/calibrate/fit-resolver-calibration.ts` pipeline. Legacy rows
   * inserted by ad-hoc trainers carry `fittedAt: null` so the freshness
   * gate (see {@link CalibrationStore.loadIfFresh}) can refuse to trust
   * them and the AdmissionGate `calibrationTrusted` flag stays `false`
   * until a real nightly fit lands. Optional for backward compatibility.
   */
  readonly fittedAt?: Date;

  /** Hash of the trace dataset used for fitting; diagnostics only. Optional. */
  readonly datasetHash?: string;

  /** Number of (score,correct) pairs used for fitting; diagnostics only. Optional. */
  readonly sampleSize?: number;
}

/**
 * Result of a freshness-gated load: either the params are fresh enough to
 * be trusted by AdmissionGate, or they're stale / missing and trust must
 * be withheld (silently disabling the hallucination guard would be the
 * #1 bug here — fail loud via {@link FreshCalibrationLoadResult.trusted}).
 */
export type FreshCalibrationLoadResult =
  | {
      readonly trusted: true;
      readonly params: CalibrationParams;
    }
  | {
      readonly trusted: false;
      readonly reason: 'missing' | 'stale' | 'never_fitted';
      readonly params: CalibrationParams | null;
    };

/**
 * Port for persisting and retrieving score calibration parameters.
 *
 * Infrastructure adapters store calibration models per query class so
 * that the resolver can convert raw match scores into calibrated
 * probabilities.
 */
export interface CalibrationStore {
  /**
   * Retrieves calibration parameters for a given query class.
   *
   * @param queryClass - The query class to retrieve parameters for.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   * @returns The calibration parameters, or `null` if none have been trained.
   */
  getCalibrationParams(
    queryClass: QueryClass,
    signal?: AbortSignal,
  ): Promise<CalibrationParams | null>;

  /**
   * Persists calibration parameters for a given query class.
   *
   * @param queryClass - The query class these parameters apply to.
   * @param params - The calibration parameters to save.
   * @param signal - Optional {@link AbortSignal}; aborts the write query (WSE-01).
   */
  save(queryClass: QueryClass, params: CalibrationParams, signal?: AbortSignal): Promise<void>;

  /**
   * Loads calibration parameters only when they are fresh enough to be
   * trusted by the AdmissionGate confidence-refusal policy.
   *
   * Freshness is gated on `fittedAt` (NOT `trainedAt`): only parameters
   * persisted by the nightly auto-pipeline carry a non-null `fittedAt`.
   * The trust boundary is `ttlDays` (env-driven, default 14 — see
   * `CALIBRATION_TTL_DAYS`).
   *
   * Callers (notably `Calibrator`) MUST treat `trusted: false` as
   * disabling downstream confidence-refusal — failing loud rather than
   * silently passing stale-calibrated scores to the hallucination guard.
   *
   * @param queryClass - The query class to retrieve parameters for.
   * @param ttlDays - Maximum age (in days) the params may have for trust.
   * @param now - Optional clock injection for tests; defaults to `new Date()`.
   * @param signal - Optional {@link AbortSignal}; aborts the lookup query (WSE-01).
   */
  loadIfFresh(
    queryClass: QueryClass,
    ttlDays: number,
    now?: Date,
    signal?: AbortSignal,
  ): Promise<FreshCalibrationLoadResult>;
}
