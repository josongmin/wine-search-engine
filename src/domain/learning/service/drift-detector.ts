import type { DriftSignal, DriftSeverity, DriftWindow } from '../model/drift-signal.js';

/**
 * A named metric tracked by the drift detector.
 */
export interface TrackedMetric {
  /** Metric name (e.g. 'decision_confidence', 'resolve_rate'). */
  readonly name: string;

  /** Values observed in the baseline window. */
  readonly baselineValues: readonly number[];

  /** Values observed in the current window. */
  readonly currentValues: readonly number[];
}

/**
 * Configuration for drift detection thresholds.
 */
export interface DriftDetectorConfig {
  /** Z-score threshold for 'warning' severity (default: 2.0). */
  readonly warningThreshold: number;

  /** Z-score threshold for 'critical' severity (default: 3.0). */
  readonly criticalThreshold: number;

  /** Minimum number of baseline observations required (default: 30). */
  readonly minBaselineSize: number;
}

/** Default configuration per RFC-010 §7. */
const DEFAULT_DRIFT_CONFIG: DriftDetectorConfig = {
  warningThreshold: 2.0,
  criticalThreshold: 3.0,
  minBaselineSize: 30,
};

/**
 * Monitors for distribution drift in key engine metrics, per RFC-010 §7.
 *
 * Tracks moving averages of decision confidence, resolve rate, ambiguity
 * rate, and latency. Uses z-score anomaly detection to compare the
 * current window against a baseline window.
 *
 * Severity levels:
 * - `info`     — shift detected but below warning threshold.
 * - `warning`  — deviation ≥ 2σ from baseline.
 * - `critical` — deviation ≥ 3σ from baseline.
 */
export class DriftDetector {
  private readonly config: DriftDetectorConfig;

  constructor(config?: Partial<DriftDetectorConfig>) {
    this.config = { ...DEFAULT_DRIFT_CONFIG, ...config };
  }

  /**
   * Checks a set of tracked metrics for distribution drift.
   *
   * @param metrics - Metrics with baseline and current window values.
   * @param window - The time window for the current observations.
   * @returns Drift signals for any metrics that show significant shift.
   */
  detect(
    metrics: readonly TrackedMetric[],
    window: DriftWindow,
  ): readonly DriftSignal[] {
    const signals: DriftSignal[] = [];

    for (const metric of metrics) {
      const signal = this.checkMetric(metric, window);
      if (signal) {
        signals.push(signal);
      }
    }

    return signals;
  }

  /**
   * Checks a single metric for drift using z-score anomaly detection.
   *
   * @param metric - The tracked metric to check.
   * @param window - The current observation window.
   * @returns A drift signal if drift is detected, null otherwise.
   */
  checkMetric(
    metric: TrackedMetric,
    window: DriftWindow,
  ): DriftSignal | null {
    if (metric.baselineValues.length < this.config.minBaselineSize) {
      return null;
    }

    if (metric.currentValues.length === 0) {
      return null;
    }

    const baselineMean = this.mean(metric.baselineValues);
    const baselineStd = this.standardDeviation(metric.baselineValues);
    const currentMean = this.mean(metric.currentValues);

    // Avoid division by zero — if baseline has zero variance, any difference is notable
    if (baselineStd === 0) {
      if (currentMean === baselineMean) return null;

      return {
        metricName: metric.name,
        currentValue: currentMean,
        baselineValue: baselineMean,
        deviation: Infinity,
        severity: 'critical',
        detectedAt: new Date(),
        window,
      };
    }

    const zScore = Math.abs(currentMean - baselineMean) / baselineStd;
    const severity = this.classifySeverity(zScore);

    // Only report if at least info-level (any detectable shift)
    if (severity === null) return null;

    return {
      metricName: metric.name,
      currentValue: currentMean,
      baselineValue: baselineMean,
      deviation: zScore,
      severity,
      detectedAt: new Date(),
      window,
    };
  }

  /**
   * Computes the embedding centroid drift between two sets of embeddings.
   * Uses cosine distance between the mean embedding vectors.
   *
   * @param baselineEmbeddings - Baseline embedding vectors.
   * @param currentEmbeddings - Current embedding vectors.
   * @returns Cosine distance between centroids in [0, 2].
   */
  computeEmbeddingCentroidDrift(
    baselineEmbeddings: readonly (readonly number[])[],
    currentEmbeddings: readonly (readonly number[])[],
  ): number {
    if (baselineEmbeddings.length === 0 || currentEmbeddings.length === 0) {
      return 0;
    }

    const dim = baselineEmbeddings[0]!.length;
    const baselineCentroid = this.computeCentroid(baselineEmbeddings, dim);
    const currentCentroid = this.computeCentroid(currentEmbeddings, dim);

    return this.cosineDistance(baselineCentroid, currentCentroid);
  }

  /**
   * Classifies a z-score into a severity level.
   * Returns null if below any threshold.
   */
  private classifySeverity(zScore: number): DriftSeverity | null {
    if (zScore >= this.config.criticalThreshold) return 'critical';
    if (zScore >= this.config.warningThreshold) return 'warning';
    if (zScore >= 1.0) return 'info';
    return null;
  }

  /** Computes arithmetic mean. */
  private mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  /** Computes population standard deviation. */
  private standardDeviation(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const avg = this.mean(values);
    const squaredDiffs = values.reduce((sum, v) => sum + (v - avg) ** 2, 0);
    return Math.sqrt(squaredDiffs / values.length);
  }

  /** Computes the centroid (mean vector) of a set of embeddings. */
  private computeCentroid(
    embeddings: readonly (readonly number[])[],
    dim: number,
  ): number[] {
    const centroid = new Array<number>(dim).fill(0);

    for (const emb of embeddings) {
      for (let i = 0; i < dim; i++) {
        centroid[i]! += emb[i]!;
      }
    }

    for (let i = 0; i < dim; i++) {
      centroid[i]! /= embeddings.length;
    }

    return centroid;
  }

  /** Computes cosine distance (1 - cosine similarity) between two vectors. */
  private cosineDistance(a: readonly number[], b: readonly number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    const similarity = dot / denominator;
    return 1 - similarity;
  }
}
