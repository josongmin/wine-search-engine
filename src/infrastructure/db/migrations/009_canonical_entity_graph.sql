-- ADR-007 Phase 1: canonical entity graph (source_record_id is separate from public entity id).

CREATE TABLE IF NOT EXISTS canonical_entities (
  canonical_entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  canonical_label TEXT NOT NULL,
  identity_signature TEXT NOT NULL,
  producer_ref TEXT,
  region_ref TEXT,
  vintage INTEGER,
  attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  approval_state TEXT NOT NULL,
  source_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_entities_type
  ON canonical_entities(entity_type);

CREATE INDEX IF NOT EXISTS idx_canonical_entities_label
  ON canonical_entities(canonical_label);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_entities_identity_signature
  ON canonical_entities(identity_signature);

CREATE TABLE IF NOT EXISTS entity_source_links (
  canonical_entity_id TEXT NOT NULL REFERENCES canonical_entities(canonical_entity_id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  link_kind TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  approved BOOLEAN NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_system, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_source_links_canonical
  ON entity_source_links(canonical_entity_id);

CREATE TABLE IF NOT EXISTS canonical_aliases (
  alias_id TEXT PRIMARY KEY,
  canonical_entity_id TEXT NOT NULL REFERENCES canonical_entities(canonical_entity_id) ON DELETE CASCADE,
  surface_form TEXT NOT NULL,
  normalized_surface TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  approval_state TEXT NOT NULL,
  source TEXT NOT NULL,
  source_trust DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canonical_aliases_entity
  ON canonical_aliases(canonical_entity_id);

CREATE INDEX IF NOT EXISTS idx_canonical_aliases_normalized
  ON canonical_aliases(normalized_surface);

CREATE TABLE IF NOT EXISTS canonical_ambiguity_registry (
  registry_id TEXT PRIMARY KEY,
  normalized_form TEXT NOT NULL,
  canonical_entity_ids JSONB NOT NULL,
  ambiguity_types JSONB NOT NULL,
  severity TEXT NOT NULL,
  approval_state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_ambiguity_normalized
  ON canonical_ambiguity_registry(normalized_form);
