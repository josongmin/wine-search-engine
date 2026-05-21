-- 021: Tighten the `aliases.alias_type` column with a CHECK constraint and
-- expose a partial index for the new `abbreviation` alias type.
--
-- Pre-condition: alias_type is TEXT NOT NULL with no constraint. Production
-- rows include every value in `src/domain/alias/model/alias.ts::ALIAS_TYPES`.
-- The application-layer `PgAliasRepository.toAliasType` guard already
-- rejects unknown strings at read time (fail-loud, see CLAUDE.md rule 11).
-- This migration moves the same invariant into the schema so corrupted
-- writes are caught at INSERT time instead of at the next read.
--
-- New alias_type added by this rollout:
--   - 'abbreviation' — curated/LLM-proposed wine-community shorthand
--     ("CM 15", "DRC 19", "Grange 17") produced by the offline
--     `scripts/etl/generate-abbreviation-aliases.ts` ETL.
--
-- Idempotent: every block uses IF NOT EXISTS / DO $$ guards so re-running
-- the migration after a partial apply is safe.

-- 1. CHECK constraint enforcing the closed-world enum on alias_type.
--    The constraint name is stable so future ALTER TABLE … DROP CONSTRAINT
--    can target it explicitly when the enum is extended.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE constraint_name = 'aliases_alias_type_enum_chk'
       AND table_name = 'aliases'
  ) THEN
    ALTER TABLE aliases
      ADD CONSTRAINT aliases_alias_type_enum_chk
      CHECK (alias_type IN (
        'canonical',
        'translation',
        'phonetic',
        'misspelling',
        'observed_query_alias',
        'catalog_noise_alias',
        'derived_initialism',
        'abbreviation'
      ));
  END IF;
END $$;

-- 2. Partial index over the new alias_type to keep the abbreviation
--    look-aside lane cheap. Abbreviation aliases form a small fraction
--    of the total `aliases` row count (~10K curated entries on the
--    rolled-out plane); a partial index over only those rows lets
--    operators audit / spot-check / re-curate the slice without
--    scanning the full table.
CREATE INDEX IF NOT EXISTS idx_aliases_abbreviation_entity
  ON aliases (entity_id, normalized_value)
  WHERE alias_type = 'abbreviation' AND is_suppressed = FALSE;
