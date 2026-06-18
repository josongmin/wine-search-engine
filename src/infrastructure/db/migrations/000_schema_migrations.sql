-- 000_schema_migrations.sql
-- Migration ledger: records which migration files have been applied and the
-- content checksum at apply time. Runs FIRST (000_ prefix) and is fully
-- idempotent (CREATE TABLE IF NOT EXISTS) so the migrator can execute it
-- unconditionally on every boot without re-running it once recorded.
--
-- The migrator (migrate.ts) consults this table to skip already-applied
-- files and to detect post-apply file rewrites (filename present with a
-- DIFFERENT content_checksum) — which it refuses to silently re-run.
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename         TEXT        NOT NULL,
  content_checksum TEXT        NOT NULL,
  checksum_algo    TEXT        NOT NULL DEFAULT 'sha256',
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (filename)
);
