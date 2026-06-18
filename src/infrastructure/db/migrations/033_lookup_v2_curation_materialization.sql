-- 033_lookup_v2_curation_materialization.sql
--
-- T-ELV2-03 follow-up: record which snapshot build last materialized each
-- published proposal. Staging publish remains terminal; ETL sets these columns
-- after a successful snapshot artifact write (observability + ops backlog).

ALTER TABLE alias_proposals ADD COLUMN IF NOT EXISTS materialized_snapshot_id TEXT;
ALTER TABLE alias_proposals ADD COLUMN IF NOT EXISTS materialized_at TIMESTAMPTZ;

ALTER TABLE ambiguity_proposals ADD COLUMN IF NOT EXISTS materialized_snapshot_id TEXT;
ALTER TABLE ambiguity_proposals ADD COLUMN IF NOT EXISTS materialized_at TIMESTAMPTZ;

ALTER TABLE suppression_proposals ADD COLUMN IF NOT EXISTS materialized_snapshot_id TEXT;
ALTER TABLE suppression_proposals ADD COLUMN IF NOT EXISTS materialized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_alias_proposals_materialized
  ON alias_proposals (status, materialized_snapshot_id)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_ambiguity_proposals_materialized
  ON ambiguity_proposals (status, materialized_snapshot_id)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_suppression_proposals_materialized
  ON suppression_proposals (status, materialized_snapshot_id)
  WHERE status = 'published';
