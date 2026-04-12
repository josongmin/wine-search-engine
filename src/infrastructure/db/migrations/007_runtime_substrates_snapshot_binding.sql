ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS search_snapshot_id TEXT;

ALTER TABLE aliases
  ADD COLUMN IF NOT EXISTS search_snapshot_id TEXT;

ALTER TABLE ambiguity_registry
  ADD COLUMN IF NOT EXISTS search_snapshot_id TEXT;

UPDATE entities
SET search_snapshot_id = '__unbound__'
WHERE search_snapshot_id IS NULL;

UPDATE aliases
SET search_snapshot_id = '__unbound__'
WHERE search_snapshot_id IS NULL;

UPDATE ambiguity_registry
SET search_snapshot_id = '__unbound__'
WHERE search_snapshot_id IS NULL;

ALTER TABLE entities
  ALTER COLUMN search_snapshot_id SET NOT NULL;

ALTER TABLE aliases
  ALTER COLUMN search_snapshot_id SET NOT NULL;

ALTER TABLE ambiguity_registry
  ALTER COLUMN search_snapshot_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_entities_snapshot_id
  ON entities(search_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_aliases_snapshot_id
  ON aliases(search_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_ambiguity_registry_snapshot_id
  ON ambiguity_registry(search_snapshot_id);
