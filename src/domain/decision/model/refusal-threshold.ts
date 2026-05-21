/**
 * Per-class refusal threshold derived from the AURC (Area-Under-Risk-Coverage)
 * curve.
 *
 * Reference: Geifman & El-Yaniv 2017, "Selective Classification for Deep
 * Neural Networks". For a calibrated scorer the operating point is chosen
 * by walking the risk-coverage curve and picking τ such that coverage ≥
 * target_coverage with minimum observed risk.
 *
 * Production thresholds are persisted in the `refusal_thresholds` table
 * (migration 021) and surfaced at runtime through
 * {@link RefusalThresholdProvider}. The runtime policy
 * (`ConfidenceRefusalPolicy`) consults the provider per request.
 */

/**
 * Reserved query-class key used as the cross-class fallback when an unknown
 * class arrives at runtime. The derive script and the runtime policy MUST
 * agree on this constant; do not inline the string literal elsewhere.
 */
export const REFUSAL_THRESHOLD_FALLBACK_CLASS = 'general';

export interface RefusalThreshold {
  /** Query-class key (e.g. `wine_name`, `producer`, `general`). */
  readonly queryClass: string;
  /** Calibrated probability τ ∈ [0,1]; decisions with C < τ are refused. */
  readonly threshold: number;
  /** Operating point on the AURC curve at which τ was selected (0,1]. */
  readonly targetCoverage: number;
  /** Observed risk at the operating point. Diagnostic only. */
  readonly riskAtCoverage: number;
  /** Number of (score, label) tuples that produced this fit. */
  readonly sampleSize: number;
  /** AURC of the curve τ was selected from. Diagnostic only. */
  readonly aurc: number;
  /** Wall-clock time of the fit. */
  readonly fittedAt: Date;
  /** Stable hash of the input tuples; used to detect dataset drift. */
  readonly datasetHash: string;
}
