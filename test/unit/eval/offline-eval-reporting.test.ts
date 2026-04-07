import { describe, expect, it } from 'vitest';
import type { GoldenQuery } from '../../../scripts/etl/types.js';
import {
  buildDegradationAwareReleaseReport,
  buildOfflineBaselineComparison,
  buildOfflinePerQueryMetrics,
  computeBlockingEligibleSlices,
  computeDegradationReasonHistogram,
  computeExecutionModeBlockingEligibleMatrix,
  computeExecutionModeSlices,
  computeSpecializedFallbackMetrics,
  type OfflineEvalCaseResult,
} from '../../../scripts/eval/run-offline-eval.js';

function makeGoldenQuery(overrides: Partial<GoldenQuery> = {}): GoldenQuery {
  return {
    qid: 'q-1',
    query: 'Opus One 2018',
    query_class: 'exact_entity',
    scenario: 'A',
    language: 'en',
    retrieval_mode: 'entity_lookup',
    retrieval_labels: {
      relevant: [{ entity_id: 'wine-1', grade: 3 }],
    },
    decision_labels: {
      expected_decision_status: 'resolved',
      expected_entity_id: 'wine-1',
      ambiguity_expected: false,
      requires_abstain: false,
    },
    leakage_keys: {
      entity_id: 'wine-1',
      query_template_id: 'template-1',
      generation_run_id: 'run-1',
      alias_cluster_id: 'cluster-1',
    },
    annotation_tier: 'bronze',
    annotated_by: ['test'],
    release_gate_eligible: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCaseResult(overrides: Partial<OfflineEvalCaseResult> = {}): OfflineEvalCaseResult {
  return {
    query: makeGoldenQuery(),
    ranked: [{ entity_id: 'wine-1', score: 0.9 }],
    decision: {
      decision_status: 'resolved',
      top_entity_id: 'wine-1',
      decision_confidence: 0.95,
    },
    truth: {
      expected_status: 'resolved',
      expected_entity_id: 'wine-1',
      ambiguity_expected: false,
      requires_abstain: false,
      relevant: { judgments: new Map([['wine-1', 3]]) },
    },
    ...overrides,
  };
}

describe('offline eval reporting helpers', () => {
  it('builds per-query metric series including non-wrong-top1 rate', () => {
    const metrics = buildOfflinePerQueryMetrics([
      makeCaseResult(),
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-x',
          decision_confidence: 0.4,
        },
      }),
    ]);

    expect(metrics.ndcg_at_10).toHaveLength(2);
    expect(metrics.mrr_at_10).toHaveLength(2);
    expect(metrics.recall_at_3).toHaveLength(2);
    expect(metrics.decision_utility).toHaveLength(2);
    expect(metrics.non_wrong_top1_rate).toEqual([1, 0]);
  });

  it('builds baseline deltas and significance when baseline per-query metrics exist', () => {
    const currentPerQuery = buildOfflinePerQueryMetrics([
      makeCaseResult(),
      makeCaseResult(),
    ]);

    const comparison = buildOfflineBaselineComparison(
      '/tmp/baseline.json',
      {
        ndcg_at_10: 1,
        mrr_at_10: 1,
        recall_at_3: 1,
        recall_at_100: 1,
        decision_utility: 1,
        wrong_top1_rate: 0,
      },
      {
        query_count: 2,
        ndcg_at_10: 0.5,
        mrr_at_10: 0.5,
        recall_at_3: 0.5,
        recall_at_100: 0.5,
        decision_utility: 0.5,
        wrong_top1_rate: 0.5,
        by_execution_mode: {
          authoritative: { query_count: 2 },
        },
        by_blocking_eligible: {
          blocking_eligible: { query_count: 2 },
        },
        diagnostics: {
          per_query_metrics: {
            ndcg_at_10: [0.5, 0.5],
            mrr_at_10: [0.5, 0.5],
            recall_at_3: [0.5, 0.5],
            recall_at_100: [0.5, 0.5],
            decision_utility: [0.5, 0.5],
            non_wrong_top1_rate: [0.5, 0.5],
          },
        },
      },
      currentPerQuery,
    );

    expect(comparison.baseline_path).toBe('/tmp/baseline.json');
    expect(comparison.deltas.ndcg_at_10).toBeCloseTo(0.5);
    expect(comparison.deltas.wrong_top1_rate).toBeCloseTo(-0.5);
    expect(comparison.deltas.execution_mode_mix?.authoritative).toBeCloseTo(-1);
    expect(comparison.deltas.blocking_eligible_share?.blocking_eligible).toBeCloseTo(-1);
    expect(comparison.deltas.degradation_reason_distribution).toBeUndefined();
    expect(comparison.significance?.metrics).toHaveProperty('ndcg_at_10');
    expect(comparison.significance?.metrics).toHaveProperty('non_wrong_top1_rate');
    expect(comparison.significance_skipped_reason).toBeUndefined();
  });

  it('explains why significance is skipped when baseline per-query metrics are absent', () => {
    const currentPerQuery = buildOfflinePerQueryMetrics([makeCaseResult()]);

    const comparison = buildOfflineBaselineComparison(
      '/tmp/baseline.json',
      {
        ndcg_at_10: 1,
        mrr_at_10: 1,
        recall_at_3: 1,
        recall_at_100: 1,
        decision_utility: 1,
        wrong_top1_rate: 0,
      },
      {
        ndcg_at_10: 0.8,
        mrr_at_10: 0.8,
        recall_at_3: 0.8,
        recall_at_100: 0.8,
        decision_utility: 0.8,
        wrong_top1_rate: 0.2,
      },
      currentPerQuery,
    );

    expect(comparison.significance).toBeUndefined();
    expect(comparison.significance_skipped_reason).toContain('missing diagnostics.per_query_metrics');
  });

  it('computes specialized fallback rates using requested-count denominators', () => {
    const metrics = computeSpecializedFallbackMetrics([
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-1',
          decision_confidence: 0.7,
          specialized_route_requested: 'producer_browse',
          specialized_route_executed: null,
          fallback_applied: true,
          fallback_reason: 'producer_browse_fallback',
        },
      }),
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-1',
          decision_confidence: 0.95,
          specialized_route_requested: 'producer_browse',
          specialized_route_executed: 'producer_browse',
          fallback_applied: false,
          fallback_reason: null,
        },
      }),
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-1',
          decision_confidence: 0.7,
          specialized_route_requested: 'compare_candidates',
          specialized_route_executed: null,
          fallback_applied: true,
          fallback_reason: 'compare_candidates_fallback',
        },
      }),
    ]);

    expect(metrics.fallback_rate.producer_browse).toEqual({
      requested_count: 2,
      fallback_rate: 0.5,
    });
    expect(metrics.fallback_rate.region_browse).toEqual({
      requested_count: 0,
      fallback_rate: null,
    });
    expect(metrics.fallback_reason_histogram).toEqual({
      producer_browse_fallback: 1,
      compare_candidates_fallback: 1,
    });
  });

  it('builds execution-mode slices and buckets missing mode as unknown', () => {
    const slices = computeExecutionModeSlices([
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-1',
          decision_confidence: 0.9,
          execution_mode: 'authoritative',
        },
      }),
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-x',
          decision_confidence: 0.7,
          execution_mode: 'degraded',
        },
      }),
      makeCaseResult(),
    ]);

    expect(slices.authoritative?.query_count).toBe(1);
    expect(slices.authoritative?.ndcg_at_10).toBeCloseTo(1);
    expect(slices.authoritative?.wrong_top1_rate).toBe(0);
    expect(slices.degraded?.query_count).toBe(1);
    expect(slices.degraded?.wrong_top1_rate).toBe(1);
    expect(slices.degraded?.decision_utility).toBe(-1.5);
    expect(slices.unknown?.query_count).toBe(1);
    expect(slices.unknown?.ndcg_at_10).toBeCloseTo(1);
  });

  it('builds blocking-eligible slices from surfaced contract', () => {
    const slices = computeBlockingEligibleSlices([
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-1',
          decision_confidence: 0.9,
          blocking_eligible: true,
        },
      }),
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-1',
          decision_confidence: 0.7,
          blocking_eligible: false,
        },
      }),
      makeCaseResult(),
    ]);

    expect(slices.blocking_eligible?.query_count).toBe(1);
    expect(slices.blocking_eligible?.decision_utility).toBeCloseTo(1);
    expect(slices.non_blocking_eligible?.query_count).toBe(1);
    expect(slices.non_blocking_eligible?.wrong_top1_rate).toBe(0);
    expect(slices.unknown?.query_count).toBe(1);
  });

  it('builds degradation histogram and execution-mode x blocking matrix', () => {
    const results = [
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-1',
          decision_confidence: 0.7,
          execution_mode: 'degraded',
          blocking_eligible: false,
          degradation_reasons: ['reranker_unavailable', 'producer_browse_fallback'],
        },
      }),
      makeCaseResult({
        decision: {
          decision_status: 'resolved',
          top_entity_id: 'wine-1',
          decision_confidence: 0.8,
          execution_mode: 'authoritative',
          blocking_eligible: true,
          degradation_reasons: ['producer_browse_fallback'],
        },
      }),
    ];

    expect(computeDegradationReasonHistogram(results)).toEqual({
      producer_browse_fallback: 2,
      reranker_unavailable: 1,
    });
    expect(computeExecutionModeBlockingEligibleMatrix(results)).toEqual({
      authoritative: {
        blocking_eligible: {
          query_count: 1,
          share: 0.5,
        },
      },
      degraded: {
        non_blocking_eligible: {
          query_count: 1,
          share: 0.5,
        },
      },
    });
  });

  it('builds degradation-aware release report with blocking vs advisory summary', () => {
    const report = buildDegradationAwareReleaseReport({
      query_count: 4,
      by_execution_mode: {
        authoritative: { query_count: 2, ndcg_at_10: 1, mrr_at_10: 1, wrong_top1_rate: 0, decision_utility: 1 },
        degraded: { query_count: 1, ndcg_at_10: 0.5, mrr_at_10: 0.5, wrong_top1_rate: 0, decision_utility: 0.5 },
        advisory: { query_count: 1, ndcg_at_10: 0, mrr_at_10: 0, wrong_top1_rate: 0, decision_utility: 0 },
      },
      by_blocking_eligible: {
        blocking_eligible: { query_count: 2, ndcg_at_10: 1, mrr_at_10: 1, wrong_top1_rate: 0, decision_utility: 1 },
        non_blocking_eligible: { query_count: 1, ndcg_at_10: 0.5, mrr_at_10: 0.5, wrong_top1_rate: 0, decision_utility: 0.5 },
        unknown: { query_count: 1, ndcg_at_10: 0, mrr_at_10: 0, wrong_top1_rate: 0, decision_utility: 0 },
      },
      degradation_reason_histogram: {
        reranker_unavailable: 2,
        producer_browse_fallback: 1,
      },
      specialized_fallback: {
        fallback_rate: {
          producer_browse: { requested_count: 1, fallback_rate: 1 },
          region_browse: { requested_count: 0, fallback_rate: null },
          compare_candidates: { requested_count: 0, fallback_rate: null },
        },
      },
    });

    expect(report.degraded_query_share).toEqual({ query_count: 1, share: 0.25 });
    expect(report.blocking_vs_advisory_summary.advisory_queries).toEqual({ query_count: 1, share: 0.25 });
    expect(report.top_degradation_reasons[0]).toEqual({
      reason: 'reranker_unavailable',
      query_count: 2,
      share: 0.5,
    });
    expect(report.specialized_fallback_summary?.fallback_rate.producer_browse?.fallback_rate).toBe(1);
  });

  it('highlights stable accuracy with higher degraded share in baseline comparison', () => {
    const currentPerQuery = buildOfflinePerQueryMetrics([
      makeCaseResult(),
      makeCaseResult(),
    ]);

    const comparison = buildOfflineBaselineComparison(
      '/tmp/baseline.json',
      {
        ndcg_at_10: 1,
        mrr_at_10: 1,
        recall_at_3: 1,
        recall_at_100: 1,
        decision_utility: 1,
        wrong_top1_rate: 0,
        by_execution_mode: {
          degraded: { query_count: 1, ndcg_at_10: 1, mrr_at_10: 1, wrong_top1_rate: 0, decision_utility: 1 },
          authoritative: { query_count: 1, ndcg_at_10: 1, mrr_at_10: 1, wrong_top1_rate: 0, decision_utility: 1 },
        },
        by_blocking_eligible: {
          blocking_eligible: { query_count: 2, ndcg_at_10: 1, mrr_at_10: 1, wrong_top1_rate: 0, decision_utility: 1 },
        },
        degradation_reason_histogram: {
          reranker_unavailable: 1,
        },
      },
      {
        query_count: 2,
        ndcg_at_10: 0.995,
        mrr_at_10: 1,
        recall_at_3: 1,
        recall_at_100: 1,
        decision_utility: 1,
        wrong_top1_rate: 0,
        by_execution_mode: {
          authoritative: { query_count: 2 },
        },
        by_blocking_eligible: {
          blocking_eligible: { query_count: 2 },
        },
        degradation_reason_histogram: {},
        diagnostics: {
          per_query_metrics: {
            ndcg_at_10: [1, 1],
            mrr_at_10: [1, 1],
            recall_at_3: [1, 1],
            recall_at_100: [1, 1],
            decision_utility: [1, 1],
            non_wrong_top1_rate: [1, 1],
          },
        },
      },
      currentPerQuery,
    );

    expect(comparison.deltas.execution_mode_mix?.degraded).toBeCloseTo(0.5);
    expect(comparison.deltas.degradation_reason_distribution?.reranker_unavailable).toEqual({
      count_delta: 1,
      percentage_point_delta: 0.5,
    });
    expect(comparison.highlights).toContain('accuracy stable but degraded share up (50.0pp)');
  });
});
