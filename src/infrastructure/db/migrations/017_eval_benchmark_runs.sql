CREATE TABLE IF NOT EXISTS eval_benchmark_runs (
  run_id TEXT PRIMARY KEY,
  benchmark_kind TEXT NOT NULL,
  search_snapshot_id TEXT NOT NULL,
  eval_dataset_version TEXT NOT NULL,
  feature_schema_hash TEXT NOT NULL,
  query_count INT NOT NULL CHECK (query_count >= 0),
  recall_at_1 FLOAT8,
  recall_at_3 FLOAT8,
  mrr FLOAT8,
  false_exact_rate FLOAT8,
  release_gate_passed BOOLEAN NOT NULL,
  activation_status TEXT NOT NULL,
  report_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (activation_status IN ('activated', 'shadow_only'))
);

CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_kind_created
  ON eval_benchmark_runs(benchmark_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_snapshot_created
  ON eval_benchmark_runs(search_snapshot_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_gate_created
  ON eval_benchmark_runs(release_gate_passed, created_at DESC);
