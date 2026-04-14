-- Migration 017 (MANUAL rollback only — NOT run by the auto-migrator):
-- revert runtime plane composite PKs back to migration 015 state.
--
-- PRE-CONDITION 1: scripts/ops/reap-snapshots.ts --force must have run first
-- to delete rows where search_snapshot_id NOT IN (active, previous). Otherwise
-- the global PK restoration below fails with duplicate key on (entity_id) /
-- (alias_id) / (registry_id).
--
-- PRE-CONDITION 2: cross-snapshot duplicates within (active, previous) must be
-- resolved manually by keeping the active_search_snapshot.active_snapshot_id
-- row and dropping previous_snapshot_id rows:
--
--   DELETE FROM entities a
--     USING entities b, active_search_snapshot ptr
--     WHERE a.entity_id = b.entity_id
--       AND a.search_snapshot_id = ptr.previous_snapshot_id
--       AND b.search_snapshot_id = ptr.active_snapshot_id;
--
--   -- Repeat for aliases / ambiguity_registry with their id columns.
--
-- SEMANTIC LOSS: after this migration, pointer-based rollback no longer works
-- for any entity that was updated between (previous, active). The operator
-- running this script is accepting that loss explicitly.

-- entities: composite PK -> global PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_snapshot_pkey'
  ) THEN
    ALTER TABLE entities DROP CONSTRAINT entities_snapshot_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_pkey'
  ) THEN
    ALTER TABLE entities ADD CONSTRAINT entities_pkey PRIMARY KEY (entity_id);
  END IF;
END
$$;

DROP INDEX IF EXISTS uq_entities_snapshot_identity_signature;

CREATE UNIQUE INDEX IF NOT EXISTS uq_entities_identity_signature
  ON entities(identity_signature)
  WHERE length(identity_signature) > 0;

-- aliases: composite PK -> global PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aliases_snapshot_pkey'
  ) THEN
    ALTER TABLE aliases DROP CONSTRAINT aliases_snapshot_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'aliases_pkey'
  ) THEN
    ALTER TABLE aliases ADD CONSTRAINT aliases_pkey PRIMARY KEY (alias_id);
  END IF;
END
$$;

-- ambiguity_registry: composite PK -> global PK
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ambiguity_registry_snapshot_pkey'
  ) THEN
    ALTER TABLE ambiguity_registry DROP CONSTRAINT ambiguity_registry_snapshot_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ambiguity_registry_pkey'
  ) THEN
    ALTER TABLE ambiguity_registry ADD CONSTRAINT ambiguity_registry_pkey PRIMARY KEY (registry_id);
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_ambiguity_snapshot_normalized;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ambiguity_normalized
  ON ambiguity_registry(normalized_form);

-- entity_snapshots FK restore (optional — can be left dropped since
-- application-level guard is preferred). Uncomment if operators need exact
-- pre-016 state.
-- ALTER TABLE entity_snapshots
--   ADD CONSTRAINT entity_snapshots_entity_id_fkey
--   FOREIGN KEY (entity_id) REFERENCES entities(entity_id);
