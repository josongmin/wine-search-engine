import type { ConstraintBundle } from '../../shared/types/index.js';
import type { QueryIntent } from '../model/query-intent.js';
import type { QueryRoute } from '../model/query-route.js';
import type { RetrievalMode } from '../model/retrieval-mode.js';
import type { AnchorCandidate } from '../model/anchor-candidate.js';
import type { QueryTargetType } from '../model/query-target-type.js';
import { STYLE_SENSORY_ATTRIBUTES } from '../../shared/constants/constraint-attributes.js';
import { hasVintageYear as hasBoundedVintageYear } from '../../shared/utils/vintage.js';
import {
  ANCHOR_PRESENT_CONFIDENCE,
  EXACT_ANCHOR_CONFIDENCE,
} from './planner-intent-detection.js';
import { regionHierarchySlashCount } from './planner-helpers.js';
import {
  PRODUCER_BROWSE_QUERY_PATTERN,
  REGION_KEYWORDS,
} from './planner-constants.js';

/**
 * Determines the query route based on intent and anchors.
 *
 * RCA5-02 fix: `mixed_query` without any anchor must route to `'hybrid'`,
 * not `'mixed'`. The `'mixed'` route requires an anchor to perform the
 * anchor-similarity pass; without one, the execution layer falls through to
 * a plain hybrid search anyway, but the plan advertises 'mixed' — causing
 * route/mode mismatch where mode='attribute_search' but route='mixed'.
 * Aligning route to 'hybrid' when no anchor is present makes the plan
 * internally consistent: `determineRetrievalMode` already maps
 * `mixed_query + !hasAnyAnchor → 'attribute_search'` (hybrid strategy).
 */
export function determineRoute(
  intent: QueryIntent,
  anchors: readonly AnchorCandidate[],
): QueryRoute {
  switch (intent) {
    case 'entity_exact':
      return 'entity';
    case 'entity_fuzzy':
      return anchors.length > 0 ? 'entity' : 'hybrid';
    case 'comparison_search':
      return 'entity';
    case 'mixed_query':
      // Only route to 'mixed' when an anchor exists — 'mixed' requires anchor
      // evidence for the similarity pass (RFC-005 §3.3, RCA5-02).
      return anchors.some((a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE)
        ? 'mixed'
        : 'hybrid';
    case 'facet_search':
    case 'semantic_discovery':
    case 'pairing_search':
    case 'budget_search':
      return 'hybrid';
  }
}

/**
 * Determines the fine-grained retrieval mode based on intent, anchors, and query surface.
 * RFC-017 §8.3: maps intent + context to a specific retrieval strategy.
 *
 * Mode selection logic (from Epic 7):
 *  - entity_exact → entity_lookup
 *  - entity_fuzzy + anchor present      → entity_resolution
 *  - comparison_search → compare_candidates
 *  - mixed_query + anchor → similar_items
 *  - pairing_search → recommendation (food / dish evidence only)
 *  - facet_search/budget_search (no anchor) → constraint_filter
 *  - semantic_discovery/generic anchor search → attribute_search
 *  - entity_exact|mixed_query + strong anchor + "best wines" → producer_browse
 *  - facet/semantic/budget + region path (≥2 '/') → region_browse
 */
export function determineRetrievalMode(
  intent: QueryIntent,
  anchors: readonly AnchorCandidate[],
  normalizedQuery: string,
): RetrievalMode {
  const hasStrongAnchor = anchors.some(
    (a) => a.confidence >= EXACT_ANCHOR_CONFIDENCE,
  );
  const hasAnyAnchor = anchors.some(
    (a) => a.confidence >= ANCHOR_PRESENT_CONFIDENCE,
  );

  // Comparison search: multiple anchors or explicit comparison intent
  if (intent === 'comparison_search') {
    return 'compare_candidates';
  }

  // Producer catalog browse ("Domaine X best wines", Epic 7)
  if (
    (intent === 'entity_exact' || intent === 'mixed_query') &&
    hasStrongAnchor &&
    PRODUCER_BROWSE_QUERY_PATTERN.test(normalizedQuery)
  ) {
    return 'producer_browse';
  }

  // Region / appellation hierarchy path ("… / Napa Valley / …", Epic 7 + golden)
  if (
    (intent === 'facet_search' ||
      intent === 'semantic_discovery' ||
      intent === 'budget_search') &&
    regionHierarchySlashCount(normalizedQuery) >= 2
  ) {
    return 'region_browse';
  }

  // Fuzzy known-item recovery stays on the identity-resolution lane even
  // when the current anchor set collapses to a single candidate. The
  // downstream decision gate treats `attribute_search` as exploratory and
  // rightfully refuses approximate sealing there; routing fuzzy entity
  // recovery through `entity_resolution` keeps the retrieval-mode contract
  // aligned with the user's actual question: "which entity did I mean?".
  if (intent === 'entity_fuzzy' && hasAnyAnchor) {
    return 'entity_resolution';
  }

  // Strong single entity lookup (exact match)
  if (intent === 'entity_exact' && hasStrongAnchor) {
    return 'entity_lookup';
  }

  // Similar items: mixed query with an anchor
  if (intent === 'mixed_query' && hasAnyAnchor) {
    return 'similar_items';
  }

  // Pairing-based recommendation
  if (intent === 'pairing_search') {
    return 'recommendation';
  }

  // Pure constraint filtering (no entity involved)
  if (
    (intent === 'facet_search' || intent === 'budget_search') &&
    !hasAnyAnchor
  ) {
    return 'constraint_filter';
  }

  // Semantic discovery and generic searches
  if (intent === 'semantic_discovery') {
    return 'attribute_search';
  }

  // Default: attribute search (hybrid vector + constraints)
  return 'attribute_search';
}

/**
 * Infers the target entity type that the query targets (Epic 8).
 *
 * Inference rules (in priority order):
 * 1. If intent is 'facet_search' or 'semantic_discovery' with only style constraints → 'style'
 * 2. If anchor present and explicit vintage year in query → 'wine'
 * 3. If anchor present and no vintage, no wine-specific terms → likely 'producer'
 * 4. If region keywords present → 'region'
 * 5. Otherwise → 'unknown' (let retrieval strategy decide)
 *
 * Returns undefined to signal "no clear target type detected" (applies default strategy).
 */
export function inferTargetEntityType(
  normalizedQuery: string,
  anchors: readonly AnchorCandidate[],
  constraints: ConstraintBundle,
  intent: QueryIntent,
): QueryTargetType | undefined {
  // Check for style-only constraints (no hard constraints about wine type or vintage).
  const hasOnlyStyleConstraints =
    constraints.hard.length === 0 &&
    constraints.soft.every((c) => STYLE_SENSORY_ATTRIBUTES.has(c.attribute));

  // If semantic discovery or facet search with only style constraints → 'style'
  if (
    (intent === 'semantic_discovery' || intent === 'facet_search') &&
    hasOnlyStyleConstraints &&
    anchors.length === 0
  ) {
    return 'style';
  }

  // Check for explicit vintage year in query (e.g., "Margaux 2015").
  const hasVintageYearInQuery = hasBoundedVintageYear(normalizedQuery);

  // If anchor and vintage year present → wine
  if (anchors.length > 0 && hasVintageYearInQuery) {
    return 'wine';
  }

  // Check for region keywords.
  const hasRegionKeyword = REGION_KEYWORDS.some((re) =>
    re.test(normalizedQuery),
  );
  if (hasRegionKeyword) {
    return 'region';
  }

  // If anchor but no vintage, no wine-specific terms → likely producer.
  // This covers queries like "안티노리" (Antinori) where we want producer set, not wine set.
  if (anchors.length > 0 && !hasVintageYearInQuery) {
    // Check for explicit wine type constraint (which would indicate wine query).
    const hasWineTypeConstraint = constraints.hard.some(
      (c) => c.attribute === 'wine_type',
    );
    if (!hasWineTypeConstraint) {
      return 'producer';
    }
  }

  // No clear signal detected.
  return undefined;
}
