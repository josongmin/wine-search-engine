-- Migration 034 (MANUAL rollback only — NOT run by the auto-migrator):
-- drop Double Metaphone recall substrate on aliases.

DROP INDEX IF EXISTS idx_aliases_phonetic_keys_gin;

ALTER TABLE aliases DROP COLUMN IF EXISTS phonetic_keys;
