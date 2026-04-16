-- Phase 5: Slice queryability view for eval benchmark runs.
--
-- Unpacks the JSONB `metrics` column into a normalized (run_id, metric_name, metric_value)
-- form so trend queries can filter/aggregate by metric name across benchmark kinds.
-- Also includes the top-level scalar columns (recall_at_1/3, mrr, false_exact_rate)
-- as virtual metric rows so all metrics are queryable through one interface.
--
-- Usage:
--   SELECT * FROM eval_benchmark_run_metrics_v
--   WHERE benchmark_kind = 'offline_eval'
--     AND metric_name = 'ndcg_at_10'
--   ORDER BY created_at DESC
--   LIMIT 10;

CREATE OR REPLACE VIEW eval_benchmark_run_metrics_v AS

-- 1. Top-level scalar columns as metric rows
SELECT
  run_id,
  benchmark_kind,
  search_snapshot_id,
  eval_dataset_version,
  release_gate_passed,
  created_at,
  'recall_at_1' AS metric_name,
  recall_at_1 AS metric_value
FROM eval_benchmark_runs
WHERE recall_at_1 IS NOT NULL

UNION ALL

SELECT
  run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
  release_gate_passed, created_at,
  'recall_at_3', recall_at_3
FROM eval_benchmark_runs
WHERE recall_at_3 IS NOT NULL

UNION ALL

SELECT
  run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
  release_gate_passed, created_at,
  'mrr', mrr
FROM eval_benchmark_runs
WHERE mrr IS NOT NULL

UNION ALL

SELECT
  run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
  release_gate_passed, created_at,
  'false_exact_rate', false_exact_rate
FROM eval_benchmark_runs
WHERE false_exact_rate IS NOT NULL

UNION ALL

SELECT
  run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
  release_gate_passed, created_at,
  'query_count', query_count::float8
FROM eval_benchmark_runs

UNION ALL

-- 2. JSONB metrics unpacked into rows
SELECT
  r.run_id,
  r.benchmark_kind,
  r.search_snapshot_id,
  r.eval_dataset_version,
  r.release_gate_passed,
  r.created_at,
  kv.key AS metric_name,
  (kv.value)::float8 AS metric_value
FROM eval_benchmark_runs r,
     LATERAL jsonb_each_text(r.metrics) AS kv(key, value)
WHERE r.metrics IS NOT NULL
  AND r.metrics != 'null'::jsonb
  AND kv.value ~ '^-?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$';


-- Trend summary: latest N runs per kind, pivoted by metric.
-- Useful for "how did ndcg_at_10 change across recent offline_eval runs?"
CREATE OR REPLACE VIEW eval_benchmark_run_trends_v AS
SELECT
  benchmark_kind,
  search_snapshot_id,
  metric_name,
  metric_value,
  release_gate_passed,
  created_at,
  run_id,
  ROW_NUMBER() OVER (
    PARTITION BY benchmark_kind, metric_name
    ORDER BY created_at DESC
  ) AS run_ordinal
FROM eval_benchmark_run_metrics_v;
