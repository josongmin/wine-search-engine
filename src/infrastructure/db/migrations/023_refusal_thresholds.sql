-- Migration 021: per-class refusal thresholds for selective prediction.
--
-- The legacy `ConfidenceRefusalPolicy` enforced a single hardcoded global
-- confidence threshold against every query class. Selective-prediction theory
-- (Geifman & El-Yaniv 2017, "Selective Classification for Deep Neural
-- Networks") shows that the operating point should be derived per-class from
-- the AURC (Area-Under-Risk-Coverage) curve so that producer queries, wine-
-- name queries, and generic browse queries can each meet their own
-- precision/recall trade-off.
--
-- This table is populated by `scripts/calibrate/derive-refusal-threshold.ts`,
-- which reads recent calibrated (score, isCorrect, queryClass) tuples from
-- eval_results and finds the threshold τ that achieves the target coverage
-- with minimum risk on the AURC curve. The runtime adapter
-- `PgRefusalThresholdStore` loads this table into an in-process TTL cache and
-- the `ConfidenceRefusalPolicy` looks up its threshold per query class.

CREATE TABLE IF NOT EXISTS refusal_thresholds (
  query_class      TEXT PRIMARY KEY,
  threshold        NUMERIC NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  target_coverage  NUMERIC NOT NULL CHECK (target_coverage > 0 AND target_coverage <= 1),
  risk_at_coverage NUMERIC NOT NULL CHECK (risk_at_coverage >= 0 AND risk_at_coverage <= 1),
  sample_size      INT     NOT NULL CHECK (sample_size >= 0),
  aurc             NUMERIC NOT NULL CHECK (aurc >= 0 AND aurc <= 1),
  fitted_at        TIMESTAMPTZ NOT NULL,
  dataset_hash     TEXT    NOT NULL
);

COMMENT ON TABLE refusal_thresholds IS
  'Per-class refusal thresholds derived from the AURC curve (Geifman & El-Yaniv 2017). Populated by scripts/calibrate/derive-refusal-threshold.ts, consumed by ConfidenceRefusalPolicy via PgRefusalThresholdStore.';

COMMENT ON COLUMN refusal_thresholds.query_class IS
  'Query-class key (e.g. wine_name, producer, general). The reserved key "general" is used as the cross-class fallback by the runtime policy when an unknown class arrives.';

COMMENT ON COLUMN refusal_thresholds.threshold IS
  'Calibrated probability τ in [0,1]. Decisions with calibrated confidence C < τ are refused.';

COMMENT ON COLUMN refusal_thresholds.target_coverage IS
  'Operating point on the AURC curve at which τ was selected. Higher coverage = lower τ = lower refusal rate.';

COMMENT ON COLUMN refusal_thresholds.risk_at_coverage IS
  'Observed risk (error rate among admitted predictions) at the chosen operating point. Diagnostic only.';

COMMENT ON COLUMN refusal_thresholds.aurc IS
  'AURC of the curve τ was selected from. Lower AURC = better calibration ordering. Diagnostic only.';

COMMENT ON COLUMN refusal_thresholds.dataset_hash IS
  'Stable hash of the (case_id, predicted_status, decision_confidence, is_correct_resolve) tuples that produced this fit. Used to detect dataset drift between successive derivations.';

CREATE INDEX IF NOT EXISTS idx_refusal_thresholds_fitted_at
  ON refusal_thresholds(fitted_at DESC);
