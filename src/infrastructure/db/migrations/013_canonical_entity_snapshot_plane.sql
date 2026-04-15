-- ADR-007 Phase 3: canonical_entities + entity_source_links become
-- snapshot-bound immutable planes.

ALTER TABLE canonical_entities
  ADD COLUMN IF NOT EXISTS search_snapshot_id TEXT;

UPDATE canonical_entities
SET search_snapshot_id = source_provenance->>'search_snapshot_id'
WHERE search_snapshot_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canonical_entities
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'canonical_entities contains legacy rows without search_snapshot_id; backfill or delete them before enabling snapshot-bound canonical graph';
  END IF;
END
$$;

ALTER TABLE canonical_entities
  ALTER COLUMN search_snapshot_id SET NOT NULL;

ALTER TABLE entity_source_links
  ADD COLUMN IF NOT EXISTS search_snapshot_id TEXT;

UPDATE entity_source_links AS esl
SET search_snapshot_id = ce.search_snapshot_id
FROM canonical_entities AS ce
WHERE ce.canonical_entity_id = esl.canonical_entity_id
  AND esl.search_snapshot_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM entity_source_links
    WHERE search_snapshot_id IS NULL OR search_snapshot_id = ''
  ) THEN
    RAISE EXCEPTION
      'entity_source_links contains legacy rows without search_snapshot_id; backfill or delete them before enabling snapshot-bound canonical graph';
  END IF;
END
$$;

ALTER TABLE entity_source_links
  ALTER COLUMN search_snapshot_id SET NOT NULL;

ALTER TABLE canonical_aliases
  DROP CONSTRAINT IF EXISTS canonical_aliases_canonical_entity_id_fkey;

ALTER TABLE entity_source_links
  DROP CONSTRAINT IF EXISTS entity_source_links_canonical_entity_id_fkey;

ALTER TABLE canonical_entities
  DROP CONSTRAINT IF EXISTS canonical_entities_pkey;

DROP INDEX IF EXISTS idx_canonical_entities_identity_signature;

ALTER TABLE canonical_entities
  ADD CONSTRAINT canonical_entities_snapshot_pkey
  PRIMARY KEY (search_snapshot_id, canonical_entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_entities_snapshot_signature
  ON canonical_entities(search_snapshot_id, identity_signature);

CREATE INDEX IF NOT EXISTS idx_canonical_entities_snapshot
  ON canonical_entities(search_snapshot_id);

ALTER TABLE canonical_aliases
  ADD CONSTRAINT canonical_aliases_snapshot_entity_fkey
  FOREIGN KEY (search_snapshot_id, canonical_entity_id)
  REFERENCES canonical_entities(search_snapshot_id, canonical_entity_id)
  ON DELETE CASCADE;

ALTER TABLE entity_source_links
  DROP CONSTRAINT IF EXISTS entity_source_links_pkey;

ALTER TABLE entity_source_links
  ADD CONSTRAINT entity_source_links_snapshot_pkey
  PRIMARY KEY (search_snapshot_id, source_system, source_record_id);

ALTER TABLE entity_source_links
  ADD CONSTRAINT entity_source_links_snapshot_entity_fkey
  FOREIGN KEY (search_snapshot_id, canonical_entity_id)
  REFERENCES canonical_entities(search_snapshot_id, canonical_entity_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_entity_source_links_snapshot_canonical
  ON entity_source_links(search_snapshot_id, canonical_entity_id);
