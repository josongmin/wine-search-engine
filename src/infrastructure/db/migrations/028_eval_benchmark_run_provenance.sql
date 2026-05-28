-- Phase 2: Benchmark provenance separation and release-grade eval cutover.
-- Distinguish local structural runs from live runtime runs in the shared ledger,
-- and make comparison/trend queries provenance-aware.

ALTER TABLE eval_benchmark_runs
  ALTER COLUMN search_snapshot_id DROP NOT NULL;

ALTER TABLE eval_benchmark_runs
  ALTER COLUMN activation_status DROP NOT NULL;

ALTER TABLE eval_benchmark_runs
  ADD COLUMN IF NOT EXISTS provenance_schema_version INT,
  ADD COLUMN IF NOT EXISTS corpus_id TEXT,
  ADD COLUMN IF NOT EXISTS corpus_hash TEXT,
  ADD COLUMN IF NOT EXISTS runtime_target TEXT,
  ADD COLUMN IF NOT EXISTS uses_live_api BOOLEAN,
  ADD COLUMN IF NOT EXISTS smoke_synthesized BOOLEAN,
  ADD COLUMN IF NOT EXISTS threshold_source TEXT,
  ADD COLUMN IF NOT EXISTS gate_eligible BOOLEAN,
  ADD COLUMN IF NOT EXISTS suite_gate_passed BOOLEAN,
  ADD COLUMN IF NOT EXISTS readiness_passed BOOLEAN,
  ADD COLUMN IF NOT EXISTS active_ltr_models INT,
  ADD COLUMN IF NOT EXISTS label_tier_mix JSONB,
  ADD COLUMN IF NOT EXISTS slice_mix JSONB,
  ADD COLUMN IF NOT EXISTS query_class_mix JSONB,
  ADD COLUMN IF NOT EXISTS runtime_activation_status TEXT;

CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_compat_created
  ON eval_benchmark_runs(
    benchmark_kind,
    corpus_hash,
    runtime_target,
    uses_live_api,
    threshold_source,
    gate_eligible,
    created_at DESC
  );

DROP VIEW IF EXISTS eval_benchmark_run_trends_v;
DROP VIEW IF EXISTS eval_benchmark_run_metrics_v;

CREATE OR REPLACE VIEW eval_benchmark_run_metrics_v AS
SELECT
  run_id,
  benchmark_kind,
  search_snapshot_id,
  eval_dataset_version,
  provenance_schema_version,
  corpus_id,
  corpus_hash,
  runtime_target,
  uses_live_api,
  smoke_synthesized,
  threshold_source,
  gate_eligible,
  suite_gate_passed,
  readiness_passed,
  active_ltr_models,
  runtime_activation_status,
  release_gate_passed,
  created_at,
  'recall_at_1' AS metric_name,
  recall_at_1 AS metric_value
FROM eval_benchmark_runs
WHERE recall_at_1 IS NOT NULL
  AND provenance_schema_version IS NOT NULL

UNION ALL

SELECT
  run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
  provenance_schema_version, corpus_id, corpus_hash, runtime_target,
  uses_live_api, smoke_synthesized, threshold_source, gate_eligible,
  suite_gate_passed, readiness_passed, active_ltr_models, runtime_activation_status,
  release_gate_passed, created_at,
  'recall_at_3', recall_at_3
FROM eval_benchmark_runs
WHERE recall_at_3 IS NOT NULL
  AND provenance_schema_version IS NOT NULL

UNION ALL

SELECT
  run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
  provenance_schema_version, corpus_id, corpus_hash, runtime_target,
  uses_live_api, smoke_synthesized, threshold_source, gate_eligible,
  suite_gate_passed, readiness_passed, active_ltr_models, runtime_activation_status,
  release_gate_passed, created_at,
  'mrr', mrr
FROM eval_benchmark_runs
WHERE mrr IS NOT NULL
  AND provenance_schema_version IS NOT NULL

UNION ALL

SELECT
  run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
  provenance_schema_version, corpus_id, corpus_hash, runtime_target,
  uses_live_api, smoke_synthesized, threshold_source, gate_eligible,
  suite_gate_passed, readiness_passed, active_ltr_models, runtime_activation_status,
  release_gate_passed, created_at,
  'false_exact_rate', false_exact_rate
FROM eval_benchmark_runs
WHERE false_exact_rate IS NOT NULL
  AND provenance_schema_version IS NOT NULL

UNION ALL

SELECT
  run_id, benchmark_kind, search_snapshot_id, eval_dataset_version,
  provenance_schema_version, corpus_id, corpus_hash, runtime_target,
  uses_live_api, smoke_synthesized, threshold_source, gate_eligible,
  suite_gate_passed, readiness_passed, active_ltr_models, runtime_activation_status,
  release_gate_passed, created_at,
  'query_count', query_count::float8
FROM eval_benchmark_runs
WHERE provenance_schema_version IS NOT NULL

UNION ALL

SELECT
  r.run_id,
  r.benchmark_kind,
  r.search_snapshot_id,
  r.eval_dataset_version,
  r.provenance_schema_version,
  r.corpus_id,
  r.corpus_hash,
  r.runtime_target,
  r.uses_live_api,
  r.smoke_synthesized,
  r.threshold_source,
  r.gate_eligible,
  r.suite_gate_passed,
  r.readiness_passed,
  r.active_ltr_models,
  r.runtime_activation_status,
  r.release_gate_passed,
  r.created_at,
  kv.key AS metric_name,
  (kv.value)::float8 AS metric_value
FROM eval_benchmark_runs r,
     LATERAL jsonb_each_text(r.metrics) AS kv(key, value)
WHERE r.provenance_schema_version IS NOT NULL
  AND r.metrics IS NOT NULL
  AND r.metrics != 'null'::jsonb
  AND kv.key NOT IN ('recall_at_1', 'recall_at_3', 'mrr', 'false_exact_rate', 'query_count')
  AND kv.value ~ '^-?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$';

CREATE OR REPLACE VIEW eval_benchmark_run_trends_v AS
SELECT
  benchmark_kind,
  search_snapshot_id,
  provenance_schema_version,
  corpus_id,
  corpus_hash,
  runtime_target,
  uses_live_api,
  smoke_synthesized,
  threshold_source,
  gate_eligible,
  suite_gate_passed,
  readiness_passed,
  active_ltr_models,
  runtime_activation_status,
  metric_name,
  metric_value,
  release_gate_passed,
  created_at,
  run_id,
  md5(
    concat_ws(
      E'\n',
      benchmark_kind,
      coalesce(corpus_hash, ''),
      coalesce(runtime_target, ''),
      coalesce(uses_live_api::text, ''),
      coalesce(threshold_source, ''),
      coalesce(gate_eligible::text, '')
    )
  ) AS comparison_compatibility_key,
  ROW_NUMBER() OVER (
    PARTITION BY benchmark_kind, corpus_hash, runtime_target, uses_live_api, threshold_source, gate_eligible, metric_name
    ORDER BY created_at DESC
  ) AS run_ordinal
FROM eval_benchmark_run_metrics_v;
