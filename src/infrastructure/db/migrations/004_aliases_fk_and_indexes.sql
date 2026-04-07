-- 004: Add missing FK constraint on aliases.entity_id and additional indexes.
--
-- The aliases table was created without a FOREIGN KEY to entities(entity_id),
-- allowing orphaned aliases. This migration adds the constraint with
-- ON DELETE CASCADE to auto-clean aliases when entities are removed.
--
-- Also adds a missing index on eval_results.predicted_entity_id for
-- efficient entity-level result lookups.

-- Add FK constraint (aliases → entities)
-- DO $$ guard avoids failure if constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_aliases_entity'
      AND table_name = 'aliases'
  ) THEN
    ALTER TABLE aliases
      ADD CONSTRAINT fk_aliases_entity
      FOREIGN KEY (entity_id) REFERENCES entities(entity_id) ON DELETE CASCADE;
  END IF;
END $$;

-- Index on eval_results.predicted_entity_id (missing from 001)
CREATE INDEX IF NOT EXISTS idx_eval_results_predicted_entity
  ON eval_results(predicted_entity_id);

-- Index on lineage_records.action for filtering by ETL action type
CREATE INDEX IF NOT EXISTS idx_lineage_action
  ON lineage_records(action);
