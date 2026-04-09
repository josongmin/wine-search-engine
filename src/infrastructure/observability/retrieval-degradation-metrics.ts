/**
 * Infrastructure collector for retrieval degradation signals.
 *
 * Follows the same singleton + collector pattern as AgentExecutionMetricsCollector.
 * Tracks per-component degradation counts and derives aggregate rates / alerts.
 */

import type {
  RetrievalDegradationMetrics,
  RetrievalDegradationObserver,
  RetrievalDegradationSignal,
} from '../../domain/retrieval/port/retrieval-degradation-observer.port.js';

/** Minimum retrievals before alerts are emitted (avoids noisy cold-start alerts). */
const MIN_RETRIEVALS_FOR_ALERT = 20;

/** Degradation rate threshold above which an alert is generated. */
const DEGRADATION_RATE_ALERT_THRESHOLD = 0.1;

export class RetrievalDegradationMetricsCollector implements RetrievalDegradationObserver {
  private totalRetrievals = 0;
  private totalDegradations = 0;
  private readonly byComponent = new Map<string, number>();

  onRetrievalStarted(): void {
    this.totalRetrievals++;
  }

  onDegradation(signal: RetrievalDegradationSignal): void {
    this.totalDegradations++;
    this.byComponent.set(
      signal.component,
      (this.byComponent.get(signal.component) ?? 0) + 1,
    );
  }

  getMetrics(): RetrievalDegradationMetrics {
    const degradations: Record<string, number> = {};
    for (const [component, count] of this.byComponent.entries()) {
      degradations[component] = count;
    }

    const degradationRate =
      this.totalRetrievals > 0
        ? this.totalDegradations / this.totalRetrievals
        : 0;

    const alerts: string[] = [];
    if (this.totalRetrievals >= MIN_RETRIEVALS_FOR_ALERT) {
      if (degradationRate >= DEGRADATION_RATE_ALERT_THRESHOLD) {
        alerts.push('retrieval_degradation_rate_high');
      }

      // Per-component alerts when any single component degrades > 10% of retrievals
      for (const [component, count] of this.byComponent.entries()) {
        const componentRate = count / this.totalRetrievals;
        if (componentRate >= DEGRADATION_RATE_ALERT_THRESHOLD) {
          alerts.push(`retrieval_${component}_degradation_high`);
        }
      }
    }

    return {
      totalRetrievals: this.totalRetrievals,
      degradations,
      degradationRate,
      alerts,
    };
  }

  reset(): void {
    this.totalRetrievals = 0;
    this.totalDegradations = 0;
    this.byComponent.clear();
  }
}

let globalCollector: RetrievalDegradationMetricsCollector | undefined;

export function getRetrievalDegradationCollector(): RetrievalDegradationMetricsCollector {
  if (globalCollector === undefined) {
    globalCollector = new RetrievalDegradationMetricsCollector();
  }
  return globalCollector;
}
