ALTER TABLE eval_results
  ADD COLUMN IF NOT EXISTS runtime_query_class TEXT,
  ADD COLUMN IF NOT EXISTS runtime_intent TEXT,
  ADD COLUMN IF NOT EXISTS runtime_route TEXT,
  ADD COLUMN IF NOT EXISTS runtime_retrieval_mode TEXT,
  ADD COLUMN IF NOT EXISTS gold_runtime_query_class_mismatch BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN eval_results.runtime_query_class IS
  'Planner/runtime query class observed during evaluation execution.';
COMMENT ON COLUMN eval_results.runtime_intent IS
  'Planner/runtime intent observed during evaluation execution.';
COMMENT ON COLUMN eval_results.runtime_route IS
  'Effective route actually executed during evaluation.';
COMMENT ON COLUMN eval_results.runtime_retrieval_mode IS
  'Effective retrieval mode actually executed during evaluation.';
COMMENT ON COLUMN eval_results.gold_runtime_query_class_mismatch IS
  'True when eval_cases.query_class differed from the runtime executed query class.';
