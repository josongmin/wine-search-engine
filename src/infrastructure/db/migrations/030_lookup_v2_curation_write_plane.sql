-- 030_lookup_v2_curation_write_plane.sql
--
-- Purpose (T-ELV2-07):
--   Give the entity-lookup-V2 curation write plane a staged review→publish
--   lifecycle, and add staging tables for ambiguity and suppression proposals.
--   This is the STAGING substrate only — publishing here flips a proposal to
--   `published`; the runtime alias/ambiguity plane is materialised later by the
--   snapshot ETL (RFC §5: runtime-plane direct write 금지; staging→publish→runtime).
--
-- Contract:
--   - extend alias_proposals with reviewer/publish lifecycle columns
--   - constrain alias_proposals.status to the 4-state lifecycle
--   - create ambiguity_proposals / suppression_proposals staging tables
--
-- Idempotent: re-runnable (the migration runner replays every file each run).

-- alias_proposals lifecycle columns ---------------------------------------
ALTER TABLE alias_proposals ADD COLUMN IF NOT EXISTS proposed_by TEXT;
ALTER TABLE alias_proposals ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE alias_proposals ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE alias_proposals ADD COLUMN IF NOT EXISTS decision_reason TEXT;
ALTER TABLE alias_proposals ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE alias_proposals ADD COLUMN IF NOT EXISTS target_snapshot_version TEXT;

-- 4-state lifecycle constraint (guarded so the migration is idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'alias_proposals_status_check'
  ) THEN
    ALTER TABLE alias_proposals
      ADD CONSTRAINT alias_proposals_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'published'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_alias_proposals_status ON alias_proposals(status);

-- ambiguity_proposals (staging) -------------------------------------------
-- A proposal that a normalized surface maps to a cluster of distinct entities
-- that must be disambiguated (clarification) rather than resolved.
CREATE TABLE IF NOT EXISTS ambiguity_proposals (
  proposal_id TEXT PRIMARY KEY,
  normalized_form TEXT NOT NULL,
  member_entity_ids JSONB NOT NULL,
  evidence JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'published')),
  proposed_by TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  decision_reason TEXT,
  published_at TIMESTAMPTZ,
  target_snapshot_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ambiguity_proposals_status ON ambiguity_proposals(status);
CREATE INDEX IF NOT EXISTS idx_ambiguity_proposals_normalized ON ambiguity_proposals(normalized_form);

-- suppression_proposals (staging) -----------------------------------------
-- A proposal to suppress a surface (optionally scoped to one entity) from
-- resolving — e.g. a known wrong-positive trap surface.
CREATE TABLE IF NOT EXISTS suppression_proposals (
  proposal_id TEXT PRIMARY KEY,
  surface_form TEXT NOT NULL,
  target_entity_id TEXT,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'published')),
  proposed_by TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  decision_reason TEXT,
  published_at TIMESTAMPTZ,
  target_snapshot_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_suppression_proposals_status ON suppression_proposals(status);
CREATE INDEX IF NOT EXISTS idx_suppression_proposals_surface ON suppression_proposals(surface_form);
