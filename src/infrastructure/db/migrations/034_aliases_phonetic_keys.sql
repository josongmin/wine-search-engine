-- 034: Persist Double Metaphone keys on aliases for SQL recall ceiling.
--
-- Client-side DM promotion remains authoritative for exactness classification;
-- this column is a recall substrate only (see docs/double-metaphone-notes.md).
-- Keys are populated at snapshot publish time from the SSoT
-- `computeAliasPhoneticKeys()` helper.

ALTER TABLE aliases
  ADD COLUMN IF NOT EXISTS phonetic_keys text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_aliases_phonetic_keys_gin
  ON aliases USING GIN (phonetic_keys);

COMMENT ON COLUMN aliases.phonetic_keys IS
  'Sorted distinct Double Metaphone keys for normalized_value; recall substrate only.';
