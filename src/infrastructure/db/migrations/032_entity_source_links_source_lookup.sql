-- Snapshot-bound canonical graph kept the primary key on
-- (search_snapshot_id, source_system, source_record_id), which is correct for
-- immutable snapshot planes but no longer covers cross-snapshot continuity
-- lookups by (source_system, source_record_id) alone.
--
-- Build/publish continuity and explicit source-link drift audits are keyed by
-- source record, not by snapshot. Without this index those paths degrade to
-- large scans over the full entity_source_links plane and can time out.

CREATE INDEX IF NOT EXISTS idx_entity_source_links_source_lookup
  ON entity_source_links(source_system, source_record_id);
