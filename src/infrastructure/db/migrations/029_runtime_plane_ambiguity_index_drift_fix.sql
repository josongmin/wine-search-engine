-- 029_runtime_plane_ambiguity_index_drift_fix.sql
--
-- Purpose:
--   Some environments still carry the legacy global uniqueness index
--   `idx_ambiguity_normalized` from migration 001. That index conflicts with
--   the snapshot-scoped append-only runtime plane introduced in migration 016
--   because the same normalized_form may appear in multiple snapshots.
--
-- Contract:
--   - remove the global unique index if it still exists
--   - ensure the per-snapshot uniqueness/index pair exists

DROP INDEX IF EXISTS idx_ambiguity_normalized;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ambiguity_snapshot_normalized
  ON ambiguity_registry(search_snapshot_id, normalized_form);

CREATE INDEX IF NOT EXISTS idx_ambiguity_registry_search_snapshot
  ON ambiguity_registry(search_snapshot_id);
