ALTER TABLE eval_results
ADD COLUMN IF NOT EXISTS retrieval_provenance_slices JSONB NOT NULL DEFAULT '[]';
