-- Migration 016: runtime plane snapshot-scoped composite primary keys.
--
-- Restores the append-only publish contract declared in migration 010's
-- comments by making (search_snapshot_id, <id>) the actual unique constraint
-- on the runtime-plane tables. Canonical plane (migrations 012/013) is already
-- on this model; this brings runtime plane in line so pointer-based rollback
-- actually works.
--
-- Scope:
--   1. entities: PK (entity_id) -> PK (search_snapshot_id, entity_id).
--      UNIQUE identity_signature -> UNIQUE (search_snapshot_id, identity_signature)
--      partial WHERE length(identity_signature) > 0.
--   2. aliases:  PK (alias_id) -> PK (search_snapshot_id, alias_id).
--   3. ambiguity_registry: PK (registry_id) -> PK (search_snapshot_id, registry_id).
--      UNIQUE normalized_form -> UNIQUE (search_snapshot_id, normalized_form).
--   4. entity_snapshots: drop the FK to entities(entity_id) so the composite
--      PK change on entities doesn't cascade-break this archive table.
--
-- Safety: every ALTER is wrapped in a DO block guarding on constraint
-- existence so the migration is idempotent and partial-application safe.
-- Backfill guard on NULL search_snapshot_id mirrors migration 012's pattern.

-- --------------------------------------------------------------------------
-- Backfill / NULL guard
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM entities
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'entities contains legacy rows without search_snapshot_id; backfill or delete before running migration 016';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM aliases
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'aliases contains legacy rows without search_snapshot_id; backfill or delete before running migration 016';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ambiguity_registry
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'ambiguity_registry contains legacy rows without search_snapshot_id; backfill or delete before running migration 016';
  END IF;
END
$$;

-- --------------------------------------------------------------------------
-- entity_snapshots FK drop (must happen BEFORE entities PK change to avoid
-- cascade lock conflicts).
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entity_snapshots_entity_id_fkey'
  ) THEN
    ALTER TABLE entity_snapshots
      DROP CONSTRAINT entity_snapshots_entity_id_fkey;
  END IF;
END
$$;

COMMENT ON TABLE entity_snapshots IS
  'Runtime plane composite-PK migration: FK to entities(entity_id) dropped because entities PK is now composite (search_snapshot_id, entity_id). Archive invariant is enforced at the publisher level instead of the DB level.';

-- --------------------------------------------------------------------------
-- aliases FK drop (must happen BEFORE entities PK change because the old FK
-- depends on entities(entity_id)).
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_aliases_entity'
  ) THEN
    ALTER TABLE aliases
      DROP CONSTRAINT fk_aliases_entity;
  END IF;
END
$$;

-- --------------------------------------------------------------------------
-- entities
-- --------------------------------------------------------------------------
-- Drop global PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_pkey'
  ) THEN
    ALTER TABLE entities DROP CONSTRAINT entities_pkey;
  END IF;
END
$$;

-- Add composite PK
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_snapshot_pkey'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_snapshot_pkey
      PRIMARY KEY (search_snapshot_id, entity_id);
  END IF;
END
$$;

-- Drop global identity_signature UNIQUE (from migration 011 partial index
-- AND migration 001 table-level UNIQUE).
DROP INDEX IF EXISTS uq_entities_identity_signature;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entities_identity_signature_key'
  ) THEN
    ALTER TABLE entities
      DROP CONSTRAINT entities_identity_signature_key;
  END IF;
END
$$;

-- Add snapshot-scoped identity_signature uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS uq_entities_snapshot_identity_signature
  ON entities(search_snapshot_id, identity_signature)
  WHERE length(identity_signature) > 0;

COMMENT ON INDEX uq_entities_snapshot_identity_signature IS
  'identity_signature uniqueness is per-snapshot under the append-only publish model. Partial index tolerates historical __unbound__ rows with empty signatures.';

-- --------------------------------------------------------------------------
-- aliases
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aliases_pkey'
  ) THEN
    ALTER TABLE aliases DROP CONSTRAINT aliases_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aliases_snapshot_pkey'
  ) THEN
    ALTER TABLE aliases
      ADD CONSTRAINT aliases_snapshot_pkey
      PRIMARY KEY (search_snapshot_id, alias_id);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_aliases_snapshot_entity'
  ) THEN
    ALTER TABLE aliases
      ADD CONSTRAINT fk_aliases_snapshot_entity
      FOREIGN KEY (search_snapshot_id, entity_id)
      REFERENCES entities(search_snapshot_id, entity_id)
      ON DELETE CASCADE;
  END IF;
END
$$;

-- --------------------------------------------------------------------------
-- ambiguity_registry
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ambiguity_registry_pkey'
  ) THEN
    ALTER TABLE ambiguity_registry DROP CONSTRAINT ambiguity_registry_pkey;
  END IF;
END
$$;

-- Drop the legacy global UNIQUE on normalized_form (migration 001 line 63).
DROP INDEX IF EXISTS idx_ambiguity_normalized;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ambiguity_registry_snapshot_pkey'
  ) THEN
    ALTER TABLE ambiguity_registry
      ADD CONSTRAINT ambiguity_registry_snapshot_pkey
      PRIMARY KEY (search_snapshot_id, registry_id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ambiguity_snapshot_normalized
  ON ambiguity_registry(search_snapshot_id, normalized_form);

COMMENT ON INDEX idx_ambiguity_snapshot_normalized IS
  'normalized_form uniqueness is per-snapshot. Replaces the global idx_ambiguity_normalized from migration 001.';
