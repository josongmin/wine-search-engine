import { describe, expect, it, beforeEach } from 'vitest';
import {
  RetrievalDegradationMetricsCollector,
} from '../../../src/infrastructure/observability/retrieval-degradation-metrics.js';

describe('RetrievalDegradationMetricsCollector', () => {
  let collector: RetrievalDegradationMetricsCollector;

  beforeEach(() => {
    collector = new RetrievalDegradationMetricsCollector();
  });

  it('starts with zero metrics', () => {
    const metrics = collector.getMetrics();
    expect(metrics.totalRetrievals).toBe(0);
    expect(metrics.degradations).toEqual({});
    expect(metrics.degradationRate).toBe(0);
    expect(metrics.alerts).toEqual([]);
  });

  it('counts retrievals and degradations', () => {
    collector.onRetrievalStarted();
    collector.onRetrievalStarted();
    collector.onDegradation({
      component: 'sparse_bm25',
      severity: 'error',
      reason: 'timeout',
      fallbackApplied: 'dense-only',
    });

    const metrics = collector.getMetrics();
    expect(metrics.totalRetrievals).toBe(2);
    expect(metrics.degradations).toEqual({ sparse_bm25: 1 });
    expect(metrics.degradationRate).toBe(0.5);
  });

  it('tracks multiple components independently', () => {
    for (let i = 0; i < 3; i++) collector.onRetrievalStarted();

    collector.onDegradation({
      component: 'sparse_bm25',
      severity: 'error',
      reason: 'err',
      fallbackApplied: 'dense-only',
    });
    collector.onDegradation({
      component: 'dense_semantic',
      severity: 'error',
      reason: 'err',
      fallbackApplied: 'sparse-only',
    });
    collector.onDegradation({
      component: 'dense_semantic',
      severity: 'warning',
      reason: 'err2',
      fallbackApplied: 'sparse-only',
    });

    const metrics = collector.getMetrics();
    expect(metrics.degradations).toEqual({
      sparse_bm25: 1,
      dense_semantic: 2,
    });
    expect(metrics.degradationRate).toBe(1); // 3 degradations / 3 retrievals
  });

  it('does not emit alerts below minimum retrieval threshold', () => {
    // 19 retrievals (below threshold of 20), all degraded
    for (let i = 0; i < 19; i++) {
      collector.onRetrievalStarted();
      collector.onDegradation({
        component: 'sparse_bm25',
        severity: 'error',
        reason: 'err',
        fallbackApplied: 'fallback',
      });
    }
    expect(collector.getMetrics().alerts).toEqual([]);
  });

  it('emits aggregate alert when degradation rate >= 10% with sufficient retrievals', () => {
    // 20 retrievals, 3 degraded = 15% rate
    for (let i = 0; i < 20; i++) collector.onRetrievalStarted();
    for (let i = 0; i < 3; i++) {
      collector.onDegradation({
        component: 'anchor_similarity',
        severity: 'warning',
        reason: 'err',
        fallbackApplied: 'no-anchor',
      });
    }

    const alerts = collector.getMetrics().alerts;
    expect(alerts).toContain('retrieval_degradation_rate_high');
    expect(alerts).toContain('retrieval_anchor_similarity_degradation_high');
  });

  it('does not emit alert when degradation rate < 10%', () => {
    // 20 retrievals, 1 degraded = 5% rate
    for (let i = 0; i < 20; i++) collector.onRetrievalStarted();
    collector.onDegradation({
      component: 'learned_sparse',
      severity: 'warning',
      reason: 'err',
      fallbackApplied: 'continue',
    });

    expect(collector.getMetrics().alerts).toEqual([]);
  });

  it('reset clears all counters', () => {
    for (let i = 0; i < 5; i++) collector.onRetrievalStarted();
    collector.onDegradation({
      component: 'dense_semantic',
      severity: 'error',
      reason: 'err',
      fallbackApplied: 'sparse-only',
    });

    collector.reset();
    const metrics = collector.getMetrics();
    expect(metrics.totalRetrievals).toBe(0);
    expect(metrics.degradations).toEqual({});
    expect(metrics.degradationRate).toBe(0);
    expect(metrics.alerts).toEqual([]);
  });

  it('handles all six component types', () => {
    const components = [
      'sparse_bm25',
      'learned_sparse',
      'dense_semantic',
      'anchor_similarity',
      'embedding_combiner',
      'relative_filter',
    ] as const;

    for (let i = 0; i < components.length; i++) {
      collector.onRetrievalStarted();
      collector.onDegradation({
        component: components[i]!,
        severity: i % 2 === 0 ? 'error' : 'warning',
        reason: `reason-${i}`,
        fallbackApplied: `fallback-${i}`,
      });
    }

    const metrics = collector.getMetrics();
    expect(Object.keys(metrics.degradations)).toHaveLength(6);
    for (const component of components) {
      expect(metrics.degradations[component]).toBe(1);
    }
  });
});
