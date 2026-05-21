-- P0.1 Nightly calibration auto-pipeline (RFC-006 §6, RFC-016 §3).
--
-- 1) eval_results.top1_raw_score
--    The nightly calibration trainer needs the *raw* top-1 resolver score
--    (pre-calibration) to fit Platt / Isotonic / Temperature scaling against
--    the realised is_correct_resolve label. eval_results.decision_confidence
--    is already calibrated (or post-identity in the untrusted-calibration
--    fallback), so it cannot be used to fit a new calibration model — that
--    would double-apply the transformation and silently collapse the
--    calibrator onto whatever the previous run produced.
--
--    NULL is permitted for legacy rows written before this column existed;
--    the trace extractor will simply skip those rows (sample loss is acceptable
--    for the migration cutover, hallucination guard re-enables once enough
--    fresh rows accumulate).
--
-- 2) calibration_params.fitted_at, dataset_hash, sample_size
--    Adds operator-facing diagnostics so AdmissionGate trust can be gated on
--    freshness rather than just "row exists". `fitted_at` is the canonical
--    freshness timestamp (semantically identical to the existing
--    `trained_at`, but explicitly populated by the new nightly pipeline so
--    legacy rows whose `trained_at` was set on table creation cannot
--    masquerade as fresh). `dataset_hash` and `sample_size` make it possible
--    to detect repeat-fit-on-identical-data drift in the runbook.

ALTER TABLE eval_results
  ADD COLUMN IF NOT EXISTS top1_raw_score DOUBLE PRECISION;

COMMENT ON COLUMN eval_results.top1_raw_score IS
  'Raw (pre-calibration) top-1 resolver score. Used by the nightly calibration trainer (scripts/calibrate/fit-resolver-calibration.ts). NULL for legacy rows.';

ALTER TABLE calibration_params
  ADD COLUMN IF NOT EXISTS fitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dataset_hash TEXT,
  ADD COLUMN IF NOT EXISTS sample_size INTEGER;

COMMENT ON COLUMN calibration_params.fitted_at IS
  'Timestamp the calibrator was last fitted from real eval traces. AdmissionGate trusts calibration only when fitted_at is within CALIBRATION_TTL_DAYS of now(). NULL signals legacy / never-fitted row.';
COMMENT ON COLUMN calibration_params.dataset_hash IS
  'SHA-256 of the (score,isCorrect) NDJSON dataset that produced this fit. Helps detect repeat-fits on identical traces.';
COMMENT ON COLUMN calibration_params.sample_size IS
  'Number of (score,isCorrect) pairs used for fitting. Diagnostics only — the trainer enforces a minimum-sample floor before persisting.';

-- Composite index supporting freshness queries by (query_class, fitted_at DESC).
CREATE INDEX IF NOT EXISTS idx_calibration_params_fitted_at
  ON calibration_params(query_class, fitted_at DESC);
