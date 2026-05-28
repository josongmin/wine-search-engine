-- Migration 024: persist canonical top-result LTR score components in eval_results.
--
-- The eval pipeline already emits `EvalResult.topResultScoreComponents`, but
-- the PostgreSQL adapter dropped that field on write, so the nightly
-- eval+train pipeline could not reconstruct canonical LambdaMART features.
--
-- This column stores the exact top-result score components emitted at eval
-- time. LTR training then reuses the shared extractLTRFeatures() path against
-- the persisted JSONB, preserving train-serve parity structurally.

ALTER TABLE eval_results
  ADD COLUMN IF NOT EXISTS top_result_score_components JSONB;

COMMENT ON COLUMN eval_results.top_result_score_components IS
  'Canonical top-result LTR score components captured during eval. Consumed by scripts/eval/run-eval-and-train-ltr.ts to rebuild LambdaMART training examples without train-serve skew.';
