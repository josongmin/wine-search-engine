ALTER TABLE ltr_model_registry
  ADD COLUMN IF NOT EXISTS feature_schema_hash TEXT;

ALTER TABLE ltr_model_registry
  ADD COLUMN IF NOT EXISTS copied_from_registry_id TEXT;

ALTER TABLE ltr_model_registry
  ADD COLUMN IF NOT EXISTS copied_from_snapshot_id TEXT;

UPDATE ltr_model_registry
SET feature_schema_hash = '9f8a1573d430a37d'
WHERE feature_schema_hash IS NULL;

ALTER TABLE ltr_model_registry
  ALTER COLUMN feature_schema_hash SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ltr_model_active_snapshot_feature_schema
  ON ltr_model_registry(search_snapshot_id, feature_schema_hash, query_class)
  WHERE is_active = TRUE;
