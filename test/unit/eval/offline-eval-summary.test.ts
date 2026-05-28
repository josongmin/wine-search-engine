import { describe, expect, it } from 'vitest';
import { buildOfflineEvalMarkdownSummary } from '../../../scripts/eval/offline-eval-summary.js';

describe('offline-eval-summary', () => {
  it('renders release report and baseline comparison into markdown', () => {
    const summary = buildOfflineEvalMarkdownSummary({
      query_count: 10,
      ndcg_at_10: 0.8,
      mrr_at_10: 0.75,
      recall_at_3: 0.7,
      decision_utility: 0.6,
      ece: 0.02,
      calibration_eligible_resolved_count: 8,
      ece_scope: 'trusted_resolved_only',
      provenance: {
        benchmark_kind: 'offline_eval_in_memory_regression',
        provenance_schema_version: 1,
        corpus_id: 'engine_local:regression_smoke',
        corpus_hash: 'corpus-hash',
        runtime_target: 'in_memory_test_server',
        uses_live_api: false,
        smoke_synthesized: false,
        threshold_source: 'external_fixture_thresholds',
        gate_eligible: false,
        suite_gate_passed: true,
        search_snapshot_id: null,
        runtime_activation_status: null,
        readiness_passed: null,
        active_ltr_models: null,
        dense_retrieval_enabled: true,
        query_embedding_model: 'text-embedding-3-large',
        query_embedding_model_version: 'text-embedding-3-large@v2',
        embedding_sensitive_eval: true,
        feature_schema_hash: 'feature-hash',
        comparison_compatibility_key: 'compat-key',
        run_provenance_key: 'run-key',
      },
      release_report: {
        degraded_query_share: { query_count: 2, share: 0.2 },
        heuristic_query_share: { query_count: 1, share: 0.1 },
        blocking_vs_advisory_summary: {
          blocking_eligible: { query_count: 6, share: 0.6 },
          non_blocking_eligible: { query_count: 3, share: 0.3 },
          unknown: { query_count: 1, share: 0.1 },
          advisory_queries: { query_count: 1, share: 0.1 },
        },
        top_degradation_reasons: [
          { reason: 'reranker_timeout', query_count: 2, share: 0.2 },
        ],
        specialized_fallback_summary: {
          fallback_rate: {
            producer_browse: { requested_count: 2, fallback_rate: 0.5 },
            region_browse: { requested_count: 0, fallback_rate: null },
            compare_candidates: { requested_count: 1, fallback_rate: 1 },
          },
          fallback_reason_histogram: {
            producer_browse_fallback: 1,
          },
        },
      },
      baseline_comparison: {
        baseline_path: '/tmp/baseline.json',
        deltas: {
          ndcg_at_10: 0.01,
          mrr_at_10: -0.02,
          recall_at_3: 0.03,
          recall_at_100: 0,
          decision_utility: 0.04,
          wrong_top1_rate: -0.01,
          execution_mode_mix: {
            degraded: { count_delta: 1, percentage_point_delta: 0.1 },
          },
          blocking_eligible_share: {
            blocking_eligible: { count_delta: -1, percentage_point_delta: -0.1 },
          },
        },
        highlights: ['accuracy stable but degraded share up (10.0pp)'],
        significance_skipped_reason: 'baseline report is missing diagnostics.per_query_metrics',
      },
    });

    expect(summary).toContain('## Offline Eval Regression');
    expect(summary).toContain('### Provenance');
    expect(summary).toContain('Runtime target: `in_memory_test_server`');
    expect(summary).toContain('Embedding-sensitive eval: `true`');
    expect(summary).toContain('Dense retrieval enabled: `true`');
    expect(summary).toContain('Query embedding model: `text-embedding-3-large`');
    expect(summary).toContain('### Release Report');
    expect(summary).toContain('### Baseline Comparison');
    expect(summary).toContain('ECE (trusted only): `0.0200` (n=8, scope=`trusted_resolved_only`)');
    expect(summary).toContain('`reranker_timeout` 2 (20.0%)');
    expect(summary).toContain('Degraded mix delta: `+1 (10.0pp)`');
    expect(summary).toContain('Blocking mix delta: `-1 (-10.0pp)`');
    expect(summary).toContain('Highlights: `accuracy stable but degraded share up (10.0pp)`');
  });
});
