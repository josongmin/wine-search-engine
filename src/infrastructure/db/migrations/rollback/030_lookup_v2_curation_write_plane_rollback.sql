-- Migration 030 (MANUAL rollback only — NOT run by the auto-migrator):
-- revert the entity-lookup-V2 curation write plane back to pre-030 state.
--
-- PRE-CONDITION: no consumer (ETL snapshot build, ops console) is mid-publish.
-- This drops the staging tables and the alias_proposals lifecycle additions.
-- SEMANTIC LOSS: any in-flight ambiguity/suppression proposals and the
-- reviewer/publish audit columns on alias_proposals are discarded. The
-- operator running this script accepts that loss explicitly.

-- staging tables (created by 030)
DROP TABLE IF EXISTS suppression_proposals;
DROP TABLE IF EXISTS ambiguity_proposals;

-- alias_proposals: drop the 4-state lifecycle constraint + lifecycle columns
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'alias_proposals_status_check'
  ) THEN
    ALTER TABLE alias_proposals DROP CONSTRAINT alias_proposals_status_check;
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_alias_proposals_status;

ALTER TABLE alias_proposals DROP COLUMN IF EXISTS proposed_by;
ALTER TABLE alias_proposals DROP COLUMN IF EXISTS reviewed_by;
ALTER TABLE alias_proposals DROP COLUMN IF EXISTS reviewed_at;
ALTER TABLE alias_proposals DROP COLUMN IF EXISTS decision_reason;
ALTER TABLE alias_proposals DROP COLUMN IF EXISTS published_at;
ALTER TABLE alias_proposals DROP COLUMN IF EXISTS target_snapshot_version;
