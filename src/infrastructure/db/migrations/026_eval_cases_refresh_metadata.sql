ALTER TABLE eval_cases
  ADD COLUMN IF NOT EXISTS source_corpus_hash TEXT,
  ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

COMMENT ON COLUMN eval_cases.source_corpus_hash IS
  'SHA-256 of the source corpus file used when the row was last refreshed.';
COMMENT ON COLUMN eval_cases.refreshed_at IS
  'Timestamp when this eval_cases row was last refreshed from its source corpus.';
