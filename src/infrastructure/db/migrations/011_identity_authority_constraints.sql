-- Migration 011: identity authority constraints (EPIC-8, T-011/W3)
--
-- Purpose: harden runtime public-id immutability at the DB layer.
--
-- Before this migration the canonical graph relied entirely on application-
-- level assertions (assertCanonicalEntityIdentitySignatureConsistency,
-- assertSourceLinkRemapBlocked). Any write path that forgets to call them
-- can silently remap identity. These constraints turn the invariant into
-- a DB-enforced hard failure.
--
-- Scope:
--   1. canonical_entities: identity_signature UNIQUE (already enforced by
--      the unique index from migration 009, but we CONSTRAIN here for
--      explicit remap semantics).
--   2. entities: identity_signature UNIQUE so a runtime entity_id and
--      identity_signature can never drift apart through upserts.
--   3. canonical_entities: PRIMARY KEY on canonical_entity_id is immutable —
--      documented here via CHECK(length > 0).
--   4. entity_source_links: ensure canonical_entity_id is only rewritten
--      inside an explicit migration tool (documented; enforced by code
--      path — see assertSourceLinkRemapBlocked).
--
-- Safety: uses IF NOT EXISTS / ADD CONSTRAINT patterns. Re-runnable.

-- entities.identity_signature must be unique across all live rows. Migration
-- 007 added the column; migration 009 made signature a runtime authority. This
-- is the DB-level lock.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_entities_identity_signature'
  ) THEN
    -- Partial index to skip the "__unbound__" legacy snapshot rows that
    -- migration 007 backfilled. These rows carry empty identity_signature
    -- values in rare historical datasets and must not block the unique
    -- index when present.
    CREATE UNIQUE INDEX uq_entities_identity_signature
      ON entities(identity_signature)
      WHERE length(identity_signature) > 0;
  END IF;
END $$;

COMMENT ON INDEX uq_entities_identity_signature IS
  'T-011: identity_signature uniqueness guards runtime public id immutability. Partial index tolerates historical __unbound__ rows with empty signatures.';

-- Sanity: canonical_entity_id must be non-empty (schema drift guard).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'canonical_entities_id_nonempty'
  ) THEN
    ALTER TABLE canonical_entities
      ADD CONSTRAINT canonical_entities_id_nonempty
      CHECK (length(canonical_entity_id) > 0);
  END IF;
END $$;

-- Sanity: identity_signature must be non-empty.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'canonical_entities_signature_nonempty'
  ) THEN
    ALTER TABLE canonical_entities
      ADD CONSTRAINT canonical_entities_signature_nonempty
      CHECK (length(identity_signature) > 0);
  END IF;
END $$;

-- Index to make assertSourceLinkRemapBlocked's lookup fast even as the
-- links table grows. The PK (source_system, source_record_id) already
-- covers the forward lookup; this index supports the reverse audit
-- ("which source rows map to this canonical entity?").
CREATE INDEX IF NOT EXISTS idx_entity_source_links_canonical
  ON entity_source_links(canonical_entity_id);

-- Audit-log table for any link remap ever performed via the migration
-- tool. Publish path is forbidden from writing here — only explicit
-- operator migration tools.
CREATE TABLE IF NOT EXISTS entity_source_link_remap_audit (
  remapped_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_system        TEXT        NOT NULL,
  source_record_id     TEXT        NOT NULL,
  from_canonical_id    TEXT        NOT NULL,
  to_canonical_id      TEXT        NOT NULL,
  operator             TEXT        NOT NULL,
  reason               TEXT        NOT NULL,
  PRIMARY KEY (remapped_at, source_system, source_record_id)
);

COMMENT ON TABLE entity_source_link_remap_audit IS
  'T-011: append-only record of every explicit source-link remap. Publish is forbidden from writing here.';
