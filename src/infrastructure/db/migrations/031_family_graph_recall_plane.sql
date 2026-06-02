-- 031_family_graph_recall_plane.sql
--
-- Purpose (T-ELV2-06 Half B):
--   Snapshot-scoped producer family adjacency for the entity-lookup-V2
--   `family_graph` recall channel. Each row links a producer family (family_key
--   = normalized producer) to one member entity, with the family size and a
--   graph-derived edge weight (1 - 1/familySize). The retrieval engine walks
--   from an alias-recalled anchor to its family and emits the siblings.
--
-- Contract (mirrors ambiguity_registry's snapshot binding, migration 001/016):
--   - snapshot-scoped (search_snapshot_id); append-only per published snapshot
--   - one row per (snapshot, family, member); the anchor→family lookup is driven
--     by idx_entity_family_snapshot_member
--   - populated by the build-family-graph ETL + publish-runtime-substrates
--     (REAL producers only — label-fallback rows are excluded at build time)
--
-- Idempotent: re-runnable (the migration runner replays every file each run).

CREATE TABLE IF NOT EXISTS entity_family (
  family_id TEXT NOT NULL,
  search_snapshot_id TEXT NOT NULL,
  family_key TEXT NOT NULL,
  member_entity_id TEXT NOT NULL,
  family_size INT NOT NULL,
  edge_weight DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (search_snapshot_id, family_id, member_entity_id)
);

-- Anchor → family lookup driver (the hot runtime path).
CREATE INDEX IF NOT EXISTS idx_entity_family_snapshot_member
  ON entity_family(search_snapshot_id, member_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_family_snapshot_key
  ON entity_family(search_snapshot_id, family_key);
CREATE INDEX IF NOT EXISTS idx_entity_family_search_snapshot
  ON entity_family(search_snapshot_id);
