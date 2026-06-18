-- Migration 033 (MANUAL rollback only — NOT run by the auto-migrator):
-- revert materialization tracking columns on curation staging tables.
--
-- PRE-CONDITION: no snapshot publish is mid-flight; operators accept losing
-- materialized_snapshot_id / materialized_at telemetry (backlog signal resets).

DROP INDEX IF EXISTS idx_suppression_proposals_materialized;
DROP INDEX IF EXISTS idx_ambiguity_proposals_materialized;
DROP INDEX IF EXISTS idx_alias_proposals_materialized;

ALTER TABLE suppression_proposals DROP COLUMN IF EXISTS materialized_at;
ALTER TABLE suppression_proposals DROP COLUMN IF EXISTS materialized_snapshot_id;

ALTER TABLE ambiguity_proposals DROP COLUMN IF EXISTS materialized_at;
ALTER TABLE ambiguity_proposals DROP COLUMN IF EXISTS materialized_snapshot_id;

ALTER TABLE alias_proposals DROP COLUMN IF EXISTS materialized_at;
ALTER TABLE alias_proposals DROP COLUMN IF EXISTS materialized_snapshot_id;
