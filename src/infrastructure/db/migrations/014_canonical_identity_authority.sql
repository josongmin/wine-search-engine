-- Migration 014: restore DB-level global identity authority outside the
-- snapshot-bound canonical_entities projection plane.

CREATE TABLE IF NOT EXISTS canonical_identity_authority (
  identity_signature TEXT PRIMARY KEY,
  canonical_entity_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT canonical_identity_authority_identity_signature_nonempty
    CHECK (length(identity_signature) > 0),
  CONSTRAINT canonical_identity_authority_canonical_entity_id_nonempty
    CHECK (length(canonical_entity_id) > 0)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canonical_entities
    GROUP BY identity_signature
    HAVING COUNT(DISTINCT canonical_entity_id) > 1
  ) THEN
    RAISE EXCEPTION
      'canonical_entities contains conflicting canonical_entity_id values for the same identity_signature; resolve drift before backfilling canonical_identity_authority';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM canonical_entities
    GROUP BY canonical_entity_id
    HAVING COUNT(DISTINCT identity_signature) > 1
  ) THEN
    RAISE EXCEPTION
      'canonical_entities contains conflicting identity_signature values for the same canonical_entity_id; resolve drift before backfilling canonical_identity_authority';
  END IF;
END
$$;

INSERT INTO canonical_identity_authority (
  identity_signature,
  canonical_entity_id
)
SELECT
  identity_signature,
  MIN(canonical_entity_id) AS canonical_entity_id
FROM canonical_entities
WHERE identity_signature IS NOT NULL
  AND identity_signature <> ''
GROUP BY identity_signature
ON CONFLICT (identity_signature) DO UPDATE SET
  canonical_entity_id = EXCLUDED.canonical_entity_id,
  updated_at = NOW();
