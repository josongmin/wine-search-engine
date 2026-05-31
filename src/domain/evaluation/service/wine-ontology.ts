/**
 * Wine domain ontology for deterministic claim verification (RFC-020).
 *
 * MOVED: the actual data + pure functions now live in
 * `src/domain/shared/wine-ontology-constants.ts` (composite leaf) so that
 * sibling domains (attribute/, query/) can consume them WITHOUT a cross-domain
 * import that violates the layer DAG. This module re-exports the shared surface
 * unchanged so existing `./wine-ontology.js` and
 * `../../evaluation/service/wine-ontology.js` import paths keep working.
 *
 * New code SHOULD import directly from `@shared/wine-ontology-constants.js`
 * (or the relative `../../shared/wine-ontology-constants.js`) rather than via
 * this evaluation-layer alias.
 */

export {
  REGION_PARENTS,
  regionHierarchyDepth,
  regionsRelated,
  regionAncestors,
  GRAPE_ALIASES,
  resolveGrapeAlias,
  grapesEquivalent,
  WINE_TYPE_ALIASES,
  normalizeWineType,
  parseKoreanPrice,
} from '../../shared/wine-ontology-constants.js';
