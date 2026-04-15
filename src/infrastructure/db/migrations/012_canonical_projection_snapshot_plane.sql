-- ADR-007 Phase 2: canonical alias / ambiguity projection becomes
-- snapshot-bound immutable plane.

ALTER TABLE canonical_aliases
  ADD COLUMN IF NOT EXISTS search_snapshot_id TEXT;

UPDATE canonical_aliases AS ca
SET search_snapshot_id = COALESCE(
  ce.source_provenance->>'search_snapshot_id',
  CASE
    WHEN ca.approval_state LIKE 'snapshot_projected:%'
      THEN substring(ca.approval_state FROM '^snapshot_projected:(.+)$')
    ELSE NULL
  END
)
FROM canonical_entities AS ce
WHERE ca.canonical_entity_id = ce.canonical_entity_id
  AND ca.search_snapshot_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canonical_aliases
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'canonical_aliases contains legacy rows without search_snapshot_id; backfill or delete them before enabling snapshot-bound canonical projection';
  END IF;
END
$$;

ALTER TABLE canonical_aliases
  ALTER COLUMN search_snapshot_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_aliases_pkey'
  ) THEN
    ALTER TABLE canonical_aliases
      DROP CONSTRAINT canonical_aliases_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_aliases_snapshot_pkey'
  ) THEN
    ALTER TABLE canonical_aliases
      ADD CONSTRAINT canonical_aliases_snapshot_pkey
      PRIMARY KEY (search_snapshot_id, alias_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_canonical_aliases_snapshot_entity
  ON canonical_aliases(search_snapshot_id, canonical_entity_id);

CREATE INDEX IF NOT EXISTS idx_canonical_aliases_snapshot_normalized
  ON canonical_aliases(search_snapshot_id, normalized_surface);

ALTER TABLE canonical_ambiguity_registry
  ADD COLUMN IF NOT EXISTS search_snapshot_id TEXT;

UPDATE canonical_ambiguity_registry
SET search_snapshot_id = CASE
  WHEN approval_state LIKE 'snapshot_projected:%'
    THEN substring(approval_state FROM '^snapshot_projected:(.+)$')
  ELSE NULL
END
WHERE search_snapshot_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canonical_ambiguity_registry
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'canonical_ambiguity_registry contains legacy rows without search_snapshot_id; backfill or delete them before enabling snapshot-bound canonical projection';
  END IF;
END
$$;

ALTER TABLE canonical_ambiguity_registry
  ALTER COLUMN search_snapshot_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_ambiguity_registry_pkey'
  ) THEN
    ALTER TABLE canonical_ambiguity_registry
      DROP CONSTRAINT canonical_ambiguity_registry_pkey;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'canonical_ambiguity_registry_snapshot_pkey'
  ) THEN
    ALTER TABLE canonical_ambiguity_registry
      ADD CONSTRAINT canonical_ambiguity_registry_snapshot_pkey
      PRIMARY KEY (search_snapshot_id, registry_id);
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_canonical_ambiguity_normalized;

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_ambiguity_snapshot_normalized
  ON canonical_ambiguity_registry(search_snapshot_id, normalized_form);

CREATE INDEX IF NOT EXISTS idx_canonical_ambiguity_snapshot
  ON canonical_ambiguity_registry(search_snapshot_id);
