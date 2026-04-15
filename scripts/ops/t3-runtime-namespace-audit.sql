-- T3: Runtime namespace cutover audit (ADR-007)
-- Run against the same database as the app (psql "$DATABASE_URL" -f scripts/ops/t3-runtime-namespace-audit.sql)
--
-- Pass criteria (all six counts MUST be 0 after publish):
--   entities_vivino_prefix              = 0
--   canonical_entities_vivino_prefix    = 0
--   aliases_vivino_prefix               = 0
--   ambiguity_registry_vivino_prefix    = 0
--   canonical_ambiguity_vivino_prefix   = 0
-- And canonical graph populated:
--   canonical_entities_rows             > 0
--   canonical_aliases_rows              > 0
--   canonical_ambiguity_registry_rows   > 0
--
-- Snapshot-bound invariant:
--   canonical_aliases / canonical_ambiguity_registry are audited for the
--   active snapshot only, not as global totals across retained snapshots.

WITH active AS (
  SELECT active_snapshot_id
  FROM active_search_snapshot
  LIMIT 1
)
SELECT 'entities_vivino_prefix' AS check_name,
       count(*)::bigint AS cnt
  FROM entities, active
 WHERE search_snapshot_id = active.active_snapshot_id
   AND entity_id LIKE 'vivino-%';

WITH active AS (
  SELECT active_snapshot_id
  FROM active_search_snapshot
  LIMIT 1
)
SELECT 'canonical_entities_vivino_prefix' AS check_name,
       count(*)::bigint AS cnt
  FROM canonical_entities, active
 WHERE search_snapshot_id = active.active_snapshot_id
   AND canonical_entity_id LIKE 'vivino-%';

WITH active AS (
  SELECT active_snapshot_id
  FROM active_search_snapshot
  LIMIT 1
)
SELECT 'aliases_vivino_prefix' AS check_name,
       count(*)::bigint AS cnt
  FROM aliases, active
 WHERE search_snapshot_id = active.active_snapshot_id
   AND entity_id LIKE 'vivino-%';

WITH active AS (
  SELECT active_snapshot_id
  FROM active_search_snapshot
  LIMIT 1
)
SELECT 'ambiguity_registry_vivino_prefix' AS check_name,
       count(*)::bigint AS cnt
  FROM ambiguity_registry, active
 WHERE search_snapshot_id = active.active_snapshot_id
   AND EXISTS (
         SELECT 1 FROM unnest(entity_ids) AS eid
          WHERE eid LIKE 'vivino-%'
       );

WITH active AS (
  SELECT active_snapshot_id
  FROM active_search_snapshot
  LIMIT 1
)
SELECT 'canonical_ambiguity_vivino_prefix' AS check_name,
       count(*)::bigint AS cnt
  FROM canonical_ambiguity_registry, active
 WHERE search_snapshot_id = active.active_snapshot_id
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements_text(canonical_entity_ids) AS eid
          WHERE eid LIKE 'vivino-%'
       );

WITH active AS (
  SELECT active_snapshot_id
  FROM active_search_snapshot
  LIMIT 1
)
SELECT 'canonical_entities_rows' AS check_name,
       count(*)::bigint AS cnt
  FROM canonical_entities, active
 WHERE search_snapshot_id = active.active_snapshot_id;

WITH active AS (
  SELECT active_snapshot_id
  FROM active_search_snapshot
  LIMIT 1
)
SELECT 'canonical_aliases_rows' AS check_name,
       count(*)::bigint AS cnt
  FROM canonical_aliases, active
 WHERE search_snapshot_id = active.active_snapshot_id;

WITH active AS (
  SELECT active_snapshot_id
  FROM active_search_snapshot
  LIMIT 1
)
SELECT 'canonical_ambiguity_registry_rows' AS check_name,
       count(*)::bigint AS cnt
  FROM canonical_ambiguity_registry, active
 WHERE search_snapshot_id = active.active_snapshot_id;
