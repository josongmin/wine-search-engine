-- Phase 1: Expand eval_benchmark_runs for multi-kind benchmark ledger.
-- Make search_snapshot_id nullable (fixture evals may not have a snapshot).
-- Add JSONB metrics column for runner-specific queryable key-value metrics.

ALTER TABLE eval_benchmark_runs
  ALTER COLUMN search_snapshot_id DROP NOT NULL;

ALTER TABLE eval_benchmark_runs
  ADD COLUMN IF NOT EXISTS metrics JSONB;

-- Index for kind-based trend queries (idempotent — already exists from 017 but
-- restated here for clarity; IF NOT EXISTS makes it safe).
CREATE INDEX IF NOT EXISTS idx_eval_benchmark_runs_kind_created
  ON eval_benchmark_runs(benchmark_kind, created_at DESC);
