ALTER TABLE ltr_model_registry
  ADD COLUMN IF NOT EXISTS search_snapshot_id TEXT;

ALTER TABLE ltr_model_registry
  ADD COLUMN IF NOT EXISTS eval_dataset_version TEXT;

UPDATE ltr_model_registry
SET search_snapshot_id = '__unbound__'
WHERE search_snapshot_id IS NULL;

UPDATE ltr_model_registry
SET eval_dataset_version = '__unknown__'
WHERE eval_dataset_version IS NULL;

ALTER TABLE ltr_model_registry
  ALTER COLUMN search_snapshot_id SET NOT NULL;

ALTER TABLE ltr_model_registry
  ALTER COLUMN eval_dataset_version SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ltr_model_active_snapshot
  ON ltr_model_registry(search_snapshot_id, query_class)
  WHERE is_active = TRUE;
