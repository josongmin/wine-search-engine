-- Enable pg_trgm for fuzzy / trigram matching on alias surface forms.
-- Required for GIN trigram indexes used by the blocking adapter.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- entities table
CREATE TABLE IF NOT EXISTS entities (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('wine','vintage','producer','region','grape')),
  canonical_label TEXT NOT NULL,
  identity_signature TEXT NOT NULL UNIQUE,
  relations JSONB NOT NULL DEFAULT '{}',
  attributes JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_label ON entities(canonical_label);

-- entity_snapshots table (for rollback per RFC-001 §4.5)
CREATE TABLE IF NOT EXISTS entity_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES entities(entity_id),
  snapshot_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_entity ON entity_snapshots(entity_id);

-- aliases table
CREATE TABLE IF NOT EXISTS aliases (
  alias_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  alias_scope TEXT NOT NULL,
  surface_form TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  language TEXT,
  source TEXT NOT NULL,
  source_trust FLOAT NOT NULL DEFAULT 1.0,
  confidence FLOAT NOT NULL DEFAULT 1.0,
  is_suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aliases_entity ON aliases(entity_id);
CREATE INDEX IF NOT EXISTS idx_aliases_normalized ON aliases(normalized_value);
CREATE INDEX IF NOT EXISTS idx_aliases_surface ON aliases(surface_form);
CREATE INDEX IF NOT EXISTS idx_aliases_active ON aliases(is_suppressed) WHERE is_suppressed = FALSE;
-- GIN trigram indexes for fuzzy prefix/ILIKE matching used by PgBlockingAdapter.
-- Requires pg_trgm (created above).
CREATE INDEX IF NOT EXISTS idx_aliases_surface_trgm  ON aliases USING GIN (surface_form  gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_aliases_normalized_trgm ON aliases USING GIN (normalized_value gin_trgm_ops);

-- ambiguity_registry table
CREATE TABLE IF NOT EXISTS ambiguity_registry (
  registry_id TEXT PRIMARY KEY,
  normalized_form TEXT NOT NULL,
  entity_ids TEXT[] NOT NULL,
  ambiguity_types TEXT[] NOT NULL,
  severity TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ambiguity_normalized ON ambiguity_registry(normalized_form);

-- calibration_params table
CREATE TABLE IF NOT EXISTS calibration_params (
  query_class TEXT PRIMARY KEY,
  method TEXT NOT NULL CHECK (method IN ('platt','isotonic','temperature')),
  params JSONB NOT NULL,
  ece FLOAT NOT NULL,
  trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- decision_snapshots table
CREATE TABLE IF NOT EXISTS decision_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  snapshot_data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- threshold_profiles table
CREATE TABLE IF NOT EXISTS threshold_profiles (
  profile_id TEXT PRIMARY KEY,
  profile_data JSONB NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- lineage_records table
CREATE TABLE IF NOT EXISTS lineage_records (
  lineage_id TEXT PRIMARY KEY,
  source_record_id TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  field_changes JSONB NOT NULL DEFAULT '{}',
  source_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lineage_source ON lineage_records(source_record_id);
CREATE INDEX IF NOT EXISTS idx_lineage_entity ON lineage_records(entity_id);

-- feedback_signals table
CREATE TABLE IF NOT EXISTS feedback_signals (
  signal_id TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  query TEXT NOT NULL,
  query_class TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  is_positive BOOLEAN NOT NULL,
  session_id TEXT NOT NULL,
  decision_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_entity ON feedback_signals(entity_id);
CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_signals(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback_signals(created_at);

-- alias_proposals table
CREATE TABLE IF NOT EXISTS alias_proposals (
  proposal_id TEXT PRIMARY KEY,
  surface_form TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  proposed_type TEXT NOT NULL,
  evidence JSONB NOT NULL,
  confidence FLOAT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- threshold_proposals table
CREATE TABLE IF NOT EXISTS threshold_proposals (
  proposal_id TEXT PRIMARY KEY,
  query_class TEXT NOT NULL,
  proposed_thresholds JSONB NOT NULL,
  current_thresholds JSONB NOT NULL,
  expected_utility_delta FLOAT NOT NULL,
  evidence JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- eval_cases table
CREATE TABLE IF NOT EXISTS eval_cases (
  case_id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  query_class TEXT NOT NULL,
  expected_entity_id TEXT,
  expected_status TEXT NOT NULL,
  label_tier TEXT NOT NULL,
  annotator_agreement FLOAT,
  slice_tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_class ON eval_cases(query_class);
CREATE INDEX IF NOT EXISTS idx_eval_cases_tier ON eval_cases(label_tier);

-- eval_results table
CREATE TABLE IF NOT EXISTS eval_results (
  result_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES eval_cases(case_id),
  predicted_entity_id TEXT,
  predicted_status TEXT NOT NULL,
  decision_confidence FLOAT NOT NULL,
  utility_score FLOAT NOT NULL,
  is_correct_resolve BOOLEAN NOT NULL,
  is_wrong_resolve BOOLEAN NOT NULL,
  is_safe_abstain BOOLEAN NOT NULL,
  is_avoidable_abstain BOOLEAN NOT NULL,
  evidence_items JSONB NOT NULL DEFAULT '[]',
  latency_ms INT NOT NULL,
  decision_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_eval_results_case ON eval_results(case_id);
CREATE INDEX IF NOT EXISTS idx_eval_results_created ON eval_results(created_at);
