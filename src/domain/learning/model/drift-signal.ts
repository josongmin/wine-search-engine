/**
 * Severity levels for drift detection alerts.
 *
 * - `info`     — notable shift, no action required.
 * - `warning`  — significant shift (≥ 2σ), investigation recommended.
 * - `critical` — severe shift (≥ 3σ), immediate attention needed.
 */
export type DriftSeverity = 'info' | 'warning' | 'critical';

/**
 * The time window over which drift was measured.
 */
export interface DriftWindow {
  /** Start of the measurement window. */
  readonly start: Date;

  /** End of the measurement window. */
  readonly end: Date;
}

/**
 * A detected distribution shift in a monitored metric, per RFC-010 §7.
 *
 * The drift detector compares current metric values against a baseline
 * window using z-score anomaly detection. Drift signals trigger alerts
 * and may pause automatic promotions.
 */
export interface DriftSignal {
  /** The name of the metric that drifted (e.g. 'decision_confidence', 'resolve_rate'). */
  readonly metricName: string;

  /** The current value of the metric. */
  readonly currentValue: number;

  /** The baseline value of the metric (from the reference window). */
  readonly baselineValue: number;

  /** Number of standard deviations from the baseline (z-score). */
  readonly deviation: number;

  /** Severity classification based on deviation magnitude. */
  readonly severity: DriftSeverity;

  /** When the drift was detected. */
  readonly detectedAt: Date;

  /** The time window over which the current value was computed. */
  readonly window: DriftWindow;
}
