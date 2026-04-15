-- Migration 010: active_search_snapshot pointer
--
-- Purpose: single atomic indirection between "published snapshot artifacts"
-- and "live read path". Publish flow stages data under a snapshot_id, then
-- updates this 1-row pointer as the final step. Readers resolve the active
-- snapshot_id via this pointer and filter tables (entities, aliases,
-- ambiguity_registry, canonical_entities via entity_source_links) by that id.
--
-- Rollback: set pointer back to previous snapshot_id. Actual data remains
-- in place because publish is append/upsert only (no destructive rewrites).
--
-- Contract:
--   * exactly one row, enforced by CHECK (id = 1)
--   * active_snapshot_id references no specific table (snapshot is a logical
--     id that spans entities/aliases/ambiguity_registry/ltr_model_registry)
--   * previous_snapshot_id is nullable (first publish has no previous)
--   * promoted_at is the instant the pointer was last swapped
--   * content_hash is stamped by publish for drift detection at readiness

CREATE TABLE IF NOT EXISTS active_search_snapshot (
  id                    SMALLINT    NOT NULL PRIMARY KEY,
  active_snapshot_id    TEXT        NOT NULL,
  previous_snapshot_id  TEXT,
  content_hash          TEXT        NOT NULL,
  promoted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  promoter              TEXT        NOT NULL DEFAULT 'publish-search-snapshot',
  CHECK (id = 1),
  CHECK (length(active_snapshot_id) > 0),
  CHECK (length(content_hash) > 0)
);

COMMENT ON TABLE active_search_snapshot IS
  'Single-row atomic pointer to the currently-active search snapshot. The only DB mutation step of publish that is globally visible. Rollback = reset to previous_snapshot_id.';

COMMENT ON COLUMN active_search_snapshot.active_snapshot_id IS
  'search_snapshot_id currently served by the read path';
COMMENT ON COLUMN active_search_snapshot.previous_snapshot_id IS
  'search_snapshot_id served before the latest promote; populated for rollback';
COMMENT ON COLUMN active_search_snapshot.content_hash IS
  'Determinism fingerprint of the active snapshot artifacts (detect drift at readiness)';

-- Audit trail: every promote recorded append-only.
CREATE TABLE IF NOT EXISTS active_search_snapshot_history (
  promoted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_snapshot_id    TEXT        NOT NULL,
  previous_snapshot_id  TEXT,
  content_hash          TEXT        NOT NULL,
  promoter              TEXT        NOT NULL,
  PRIMARY KEY (promoted_at, active_snapshot_id)
);

COMMENT ON TABLE active_search_snapshot_history IS
  'Append-only audit trail of every pointer promote; feeds rollback UI / eval.';

CREATE INDEX IF NOT EXISTS idx_active_search_snapshot_history_id
  ON active_search_snapshot_history(active_snapshot_id);

-- Snapshot-scoped read indexes.
-- The read path filters by active_snapshot_id. These indexes make the
-- WHERE search_snapshot_id = $1 fast without table scans.
CREATE INDEX IF NOT EXISTS idx_entities_search_snapshot
  ON entities(search_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_aliases_search_snapshot
  ON aliases(search_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_ambiguity_registry_search_snapshot
  ON ambiguity_registry(search_snapshot_id);
