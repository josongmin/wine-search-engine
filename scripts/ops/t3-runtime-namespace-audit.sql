-- T3: Runtime namespace cutover audit (ADR-007)
-- Run against the same database as the app (psql "$DATABASE_URL" -f scripts/ops/t3-runtime-namespace-audit.sql)
--
-- Pass criteria:
--   vivino_entities = 0 AND vivino_aliases = 0
--   canonical_entities / canonical_aliases / canonical_ambiguity_registry > 0 (after graph sync + publish)

SELECT 'entities_vivino_prefix' AS check_name,
       count(*)::bigint AS cnt
  FROM entities
 WHERE entity_id LIKE 'vivino-%';

SELECT 'aliases_vivino_prefix' AS check_name,
       count(*)::bigint AS cnt
  FROM aliases
 WHERE entity_id LIKE 'vivino-%';

SELECT 'canonical_entities_rows' AS check_name,
       count(*)::bigint AS cnt
  FROM canonical_entities;

SELECT 'canonical_aliases_rows' AS check_name,
       count(*)::bigint AS cnt
  FROM canonical_aliases;

SELECT 'canonical_ambiguity_registry_rows' AS check_name,
       count(*)::bigint AS cnt
  FROM canonical_ambiguity_registry;
