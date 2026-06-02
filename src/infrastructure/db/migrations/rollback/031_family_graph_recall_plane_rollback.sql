-- Migration 031 (MANUAL rollback only — NOT run by the auto-migrator):
-- drop the entity-lookup-V2 producer family graph recall plane.
--
-- PRE-CONDITION: no snapshot publish is mid-run. SEMANTIC LOSS: all persisted
-- family adjacency for every snapshot is discarded; the family_graph recall
-- channel goes dormant (familyGraphProximity → 0) until republished. The
-- operator running this accepts that loss.

DROP TABLE IF EXISTS entity_family;
