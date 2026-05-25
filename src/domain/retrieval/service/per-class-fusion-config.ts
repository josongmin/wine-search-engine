/**
 * Per-query-class RRF fusion configuration registry.
 *
 * Epic-16 / T16-2 foundation: expose a typed registry of fusion constants
 * keyed by query class. The current values are **deterministic priors** —
 * rule-of-thumb starting points derived from retrieval intuition. They
 * will be replaced by calibrated values from the sweep harness once
 * Epic-16 learned-fusion infrastructure lands.
 *
 * Each config lives at module scope (never allocated per-call) and every
 * magic number is annotated with the heuristic it encodes.
 */

// Rule 30 SSoT: every RRF K constant is defined once in rrf.ts; import the
// RRF_K table, do not redefine locally. RRF_DEFAULT_K is preserved for
// readability at the call-site (it pairs with the "canonical k" comments).
import { RRF_DEFAULT_K, RRF_K } from '../../shared/utils/rrf.js';
import type { QueryClass as DomainQueryClass } from '../../shared/types/query-class.js';

/** Neutral weight baseline — channels contribute equally. */
const WEIGHT_NEUTRAL = 1.0;

/** Damped weight for channels that should contribute but not dominate. */
const WEIGHT_DAMPED = 0.8;

/** Halved weight for channels expected to be noisy for a given class. */
const WEIGHT_HALF = 0.5;

/** Boosted weight for the channel the query class should favor. */
const WEIGHT_BOOST_MILD = 1.5;

/** Strong boost for the dominant channel of a query class. */
const WEIGHT_BOOST_STRONG = 2.0;

/**
 * Learned-sparse weight stays at 0 until SPLADE serving lands
 * (Epic-16 / T16-6+).
 */
const LEARNED_SPARSE_DISABLED = 0.0;

interface FusionConfig {
  readonly rrfK: number;
  readonly sparseWeight: number;
  readonly denseWeight: number;
  readonly anchorWeight: number;
  readonly learnedSparseWeight: number;
}

export type QueryClass =
  | 'specific_wine'
  | 'entity_exact'
  | 'browse'
  | 'compare'
  | 'pairing'
  | 'fallback';

/**
 * Default config — used for the 'fallback' class and for unknown class
 * strings. Neutral weights, canonical RRF k.
 */
export const DEFAULT_FUSION_CONFIG: FusionConfig = {
  rrfK: RRF_DEFAULT_K,
  sparseWeight: WEIGHT_NEUTRAL,
  denseWeight: WEIGHT_NEUTRAL,
  anchorWeight: WEIGHT_NEUTRAL,
  learnedSparseWeight: LEARNED_SPARSE_DISABLED,
};

/**
 * specific_wine: known producer/cuvée lookups. Favor lexical (BM25) —
 * the user typed a name and we should surface exact token matches.
 * Tighter k so rank-1 sparse hits dominate. Anchor carries mild boost
 * because entity resolution is usually decisive for this class.
 */
const FUSION_SPECIFIC_WINE: FusionConfig = {
  rrfK: RRF_K.TIGHT,
  sparseWeight: WEIGHT_BOOST_STRONG,
  denseWeight: WEIGHT_HALF,
  anchorWeight: WEIGHT_BOOST_MILD,
  learnedSparseWeight: LEARNED_SPARSE_DISABLED,
};

/**
 * entity_exact: unambiguous single-entity lookup with a resolved anchor
 * (TRACK-A A4). The anchor channel is the strongest signal — the planner
 * resolved the entity with high confidence, so anchor hits should dominate.
 * BM25 provides a precision backstop; dense is damped to avoid drowning the
 * anchor signal with semantic neighbours. Very tight k so rank-1 anchor hits
 * are maximally separated from tail candidates.
 *
 * Weight rationale:
 *   anchor WEIGHT_BOOST_STRONG (2.0) — resolved entity is the primary target
 *   sparse WEIGHT_BOOST_MILD (1.5) — exact-token BM25 match is load-bearing
 *   dense  WEIGHT_HALF (0.5)       — ANN neighbourhood useful but must not swamp anchor
 */
const FUSION_ENTITY_EXACT: FusionConfig = {
  rrfK: RRF_K.ENTITY_EXACT,
  sparseWeight: WEIGHT_BOOST_MILD,
  denseWeight: WEIGHT_HALF,
  anchorWeight: WEIGHT_BOOST_STRONG,
  learnedSparseWeight: LEARNED_SPARSE_DISABLED,
};

/**
 * browse: open-ended exploration ("light reds under 50k"). Favor
 * semantic (dense) — the user is expressing intent, not a name.
 * Standard k so the tail contributes to recall.
 */
const FUSION_BROWSE: FusionConfig = {
  rrfK: RRF_DEFAULT_K,
  sparseWeight: WEIGHT_NEUTRAL,
  denseWeight: WEIGHT_BOOST_MILD,
  anchorWeight: WEIGHT_NEUTRAL,
  learnedSparseWeight: LEARNED_SPARSE_DISABLED,
};

/**
 * compare: "X vs Y" flows. Anchor channel drives the set (both entities
 * must be present). Tighter-than-default k because rank order is
 * meaningful for side-by-side comparisons.
 */
const FUSION_COMPARE: FusionConfig = {
  rrfK: RRF_K.COMPARE,
  sparseWeight: WEIGHT_BOOST_MILD,
  denseWeight: WEIGHT_NEUTRAL,
  anchorWeight: WEIGHT_BOOST_STRONG,
  learnedSparseWeight: LEARNED_SPARSE_DISABLED,
};

/**
 * pairing: food-pairing recommendations. Dense dominates — the query is
 * semantic ("pairs with grilled lamb"). Anchor is mostly irrelevant.
 * Looser k because the long tail carries real pairing candidates.
 */
const FUSION_PAIRING: FusionConfig = {
  rrfK: RRF_K.LOOSE,
  sparseWeight: WEIGHT_DAMPED,
  denseWeight: WEIGHT_BOOST_STRONG,
  anchorWeight: WEIGHT_HALF,
  learnedSparseWeight: LEARNED_SPARSE_DISABLED,
};

/**
 * Registry of fusion configs keyed by query class. Module-scope
 * `Map` so lookups are O(1) and the table is allocated exactly once.
 */
export const PER_CLASS_FUSION: ReadonlyMap<QueryClass, FusionConfig> = new Map<
  QueryClass,
  FusionConfig
>([
  ['specific_wine', FUSION_SPECIFIC_WINE],
  ['entity_exact', FUSION_ENTITY_EXACT],
  ['browse', FUSION_BROWSE],
  ['compare', FUSION_COMPARE],
  ['pairing', FUSION_PAIRING],
  ['fallback', DEFAULT_FUSION_CONFIG],
]);

/**
 * Resolve the fusion config for a given query class. Unknown strings
 * (including empty) fall back to {@link DEFAULT_FUSION_CONFIG} — this
 * keeps the call sites free of defensive branching.
 */
export function getFusionConfig(queryClass: QueryClass): FusionConfig {
  const found = PER_CLASS_FUSION.get(queryClass);
  return found ?? DEFAULT_FUSION_CONFIG;
}

/**
 * Canonical mapping from domain query classes to fusion query classes.
 *
 * TRACK-A A4: runtimeMode 'entity_anchor_first' overrides to 'entity_exact'
 * so anchor-dominant fusion config is used instead of specific_wine.
 */
export function mapDomainQueryClassToFusionQueryClass(
  qc: DomainQueryClass,
  runtimeMode?: string,
): QueryClass {
  if (runtimeMode === 'entity_anchor_first') {
    return 'entity_exact';
  }
  switch (qc) {
    case 'exact_entity':
    case 'short_entity':
    case 'ambiguous_short_form':
    case 'anchored_similarity':
      return 'specific_wine';
    case 'pure_constraint':
    case 'semantic_preference':
      return 'browse';
    case 'comparison_query':
      return 'compare';
    case 'unknown':
    default:
      return 'fallback';
  }
}
