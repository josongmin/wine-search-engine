/**
 * Epic 7: Retrieval Mode-specific Scoring Weights
 *
 * Maps RetrievalMode to optimized ranking weight profiles.
 * Used to adjust relevance signals based on query intent.
 *
 * RFC-017 §8.3: Different modes use different ranking strategies.
 */

import type { RetrievalMode } from '../../query/model/retrieval-mode.js';
import type { ScoringWeights } from './scoring-weights.js';

/**
 * Ranking weight profile for a retrieval mode.
 *
 * **Invariants** (enforced by `mode-weights.test.ts`):
 *   1. Every weight ∈ [0, 1].
 *   2. Every `RetrievalMode` enum value has a profile in `MODE_WEIGHT_PROFILES`.
 *   3. `DEFAULT_WEIGHTS` is all-zero so `Math.max(base, default) = base`.
 *   4. Every field on this interface is overlaid in ranker.ts (no silent
 *      lying fields). The mode-weights ↔ ScoringWeights bridge is verified
 *      by the test that asserts every field name matches a ScoringWeights
 *      counterpart.
 *
 * **Non-invariant**: profile fields do NOT sum to 1.0. Each weight is an
 * independent overlay applied via per-field floors in `ranker.ts`, with
 * optional mode-specific caps for signals that must be suppressed on a lane
 * (e.g. prestige/critic on generic attribute search). They can collectively
 * exceed 1.0 before renormalization — that's intentional.
 * Tuning a single weight changes only that signal's floor.
 *
 * All 12 non-penalty ScoringWeights fields have exactly one entry here so
 * the mode overlay in ranker.ts can apply Math.max() across all fields
 * without silently leaving 6 fields unadjusted (RCA5-04 history). Three
 * earlier fields (lexicalWeight, diversityWeight, geographicAlignmentWeight)
 * were dead — they had no ScoringWeights counterpart and were never read by
 * ranker.ts despite mode profiles populating them. Removed in PR-N to stop
 * the data table from lying about what the runtime actually applies.
 */
export interface ModeWeightProfile {
  /** Maps to ScoringWeights.semantic. */
  readonly semanticWeight: number;

  /** Maps to ScoringWeights.popularity (intentionally small — tie-breaker level). */
  readonly popularityWeight: number;

  /** Maps to ScoringWeights.entityIntegrity. */
  readonly entityIntegrityWeight: number;

  /** Maps to ScoringWeights.attributeAlignment (for filtered searches). */
  readonly attributeAlignmentWeight: number;

  /** Maps to ScoringWeights.recency (browse / comparison modes). */
  readonly recencyWeight: number;

  /** Maps to ScoringWeights.producerPrestige (producer/region browse, compare). */
  readonly producerPrestigeWeight: number;

  /** Maps to ScoringWeights.preferenceAlignment (recommendation, pairing). */
  readonly preferenceAlignmentWeight: number;

  /** Maps to ScoringWeights.anchorSimilarity. */
  readonly anchorSimilarityWeight: number;

  /** Maps to ScoringWeights.softConstraint. */
  readonly softConstraintWeight: number;

  /** Maps to ScoringWeights.availability. */
  readonly availabilityWeight: number;

  /** Maps to ScoringWeights.criticScore. */
  readonly criticScoreWeight: number;

  /** Maps to ScoringWeights.multilingualScore. */
  readonly multilingualScoreWeight: number;

  /** Maps to ScoringWeights.giftSuitability (Track C learned facet). */
  readonly giftSuitabilityWeight: number;

  /** Maps to ScoringWeights.beginnerSuitability (Track C learned facet). */
  readonly beginnerSuitabilityWeight: number;
}

/**
 * No-op fallback used when retrievalMode is undefined or unrecognised.
 * All values are 0.0 so the floor step preserves base weights exactly — the
 * query-class weights are preserved exactly with no mode interference.
 */
export const DEFAULT_WEIGHTS: ModeWeightProfile = {
  semanticWeight: 0.0,
  popularityWeight: 0.0,
  entityIntegrityWeight: 0.0,
  attributeAlignmentWeight: 0.0,
  recencyWeight: 0.0,
  producerPrestigeWeight: 0.0,
  preferenceAlignmentWeight: 0.0,
  anchorSimilarityWeight: 0.0,
  softConstraintWeight: 0.0,
  availabilityWeight: 0.0,
  criticScoreWeight: 0.0,
  multilingualScoreWeight: 0.0,
  giftSuitabilityWeight: 0.0,
  beginnerSuitabilityWeight: 0.0,
};

/**
 * Mode-to-weight-profile mapping.
 * Each mode overrides specific weights to optimize for its query intent.
 */
const MODE_WEIGHT_PROFILES: Record<RetrievalMode, ModeWeightProfile> = {
  // === Exact entity lookup: BM25 priority handled by retrieval; this overlay
  // only raises floors for the ranker's secondary signals. ===
  entity_lookup: {
    semanticWeight: 0.15,         // Secondary fallback to embedding
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.08,  // Exact type match important
    attributeAlignmentWeight: 0.02,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },

  // === Ambiguous entity: boost confidence thresholds ===
  entity_resolution: {
    semanticWeight: 0.30,         // Embedding provides tie-breaking
    popularityWeight: 0.10,        // Popularity as tertiary signal
    entityIntegrityWeight: 0.10,  // Extra emphasis on entity type matching
    attributeAlignmentWeight: 0.0,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },

  // === Attribute search: balance text + semantic ===
  attribute_search: {
    // Semantic recall still matters, but parsed sensory/style constraints are
    // first-class preference evidence on this lane. If popularity/semantic
    // dominate too hard, medium-body / sweet / dry queries collapse into
    // prestige-heavy generic results even after correct parsing.
    semanticWeight: 0.24,
    popularityWeight: 0.03,
    entityIntegrityWeight: 0.03,
    attributeAlignmentWeight: 0.18,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    preferenceAlignmentWeight: 0.10,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.20,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },

  // === Constraint filtering: favor constraint adherence ===
  constraint_filter: {
    semanticWeight: 0.20,
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.05,
    attributeAlignmentWeight: 0.35,  // Heavily favor attribute match
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.20,      // Soft constraints matter in filter mode
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },

  // === Producer browse: prestige-aware. Diversity (avoid same-vintage
  // clustering) is enforced separately by the result diversifier, not by
  // a ranker weight. ===
  producer_browse: {
    semanticWeight: 0.20,
    popularityWeight: 0.15,
    entityIntegrityWeight: 0.05,
    attributeAlignmentWeight: 0.10,
    recencyWeight: 0.05,
    producerPrestigeWeight: 0.10,       // Producer reputation matters
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.05,            // Critic score secondary for browse
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },

  // === Region browse: geographic emphasis is encoded in the retrieval
  // route's region filter; this overlay only nudges secondary signals. ===
  region_browse: {
    semanticWeight: 0.25,
    popularityWeight: 0.15,
    entityIntegrityWeight: 0.05,
    attributeAlignmentWeight: 0.15,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.05,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },

  // === Comparison: entity integrity paramount ===
  compare_candidates: {
    semanticWeight: 0.20,
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.20,        // Must be truly comparable wines
    attributeAlignmentWeight: 0.15,     // Attributes matter for comparison
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.05,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.20,       // Anchor similarity key for comparison
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.10,            // Critic score key for comparison
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },

  // === Recommendation/pairing: preference & occasion focus ===
  recommendation: {
    semanticWeight: 0.40,              // Semantic understanding of taste
    popularityWeight: 0.15,
    entityIntegrityWeight: 0.03,
    attributeAlignmentWeight: 0.17,    // Style/pairing constraints
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    preferenceAlignmentWeight: 0.25,   // Occasion/pairing preference
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.15,        // Soft constraints (pairing tags) important
    availabilityWeight: 0.0,
    criticScoreWeight: 0.10,           // Quality signals for recommendations
    multilingualScoreWeight: 0.0,
    // Track C learned facets (gift_suitability_score / beginner_suitability_score
    // ~62% populated). Wired into recommendation 2026-05-25: bench v9 showed
    // gift_refined scenarios at 30-41% scoring due to lack of "fit-for-occasion"
    // signal. Conservative weights — these are SECONDARY ranking signals; main
    // intent expressed via preferenceAlignment + softConstraint. Operator can
    // tune via mode-weight overrides if recommendation skews too giftable.
    giftSuitabilityWeight: 0.05,
    beginnerSuitabilityWeight: 0.05,
  },

  // === Similar items: anchor-based similarity. Anchor-duplicate diversity
  // is handled by the diversifier, not a ranker weight. ===
  similar_items: {
    semanticWeight: 0.50,              // Embedding is primary signal
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.05,
    attributeAlignmentWeight: 0.08,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.30,      // Anchor similarity is the main signal
    softConstraintWeight: 0.10,        // Constraint satisfaction secondary
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },

  // === No match: fallback (should rarely be reached in ranking) ===
  no_match_detection: {
    semanticWeight: 0.20,
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.0,
    attributeAlignmentWeight: 0.0,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
    giftSuitabilityWeight: 0.0,
    beginnerSuitabilityWeight: 0.0,
  },
};

/**
 * Returns the weight profile for a given retrieval mode.
 * Falls back to DEFAULT_WEIGHTS for unknown or missing modes.
 */
export function getModeWeights(mode: RetrievalMode | undefined): ModeWeightProfile {
  return (mode !== undefined ? MODE_WEIGHT_PROFILES[mode] : undefined) ?? DEFAULT_WEIGHTS;
}

/**
 * SSoT mapping from `ModeWeightProfile` field name to its
 * `ScoringWeights` counterpart. ranker.ts MUST iterate this map to apply
 * the mode overlay so a new field added to either side cannot drift —
 * the test suite verifies that every key here corresponds to a real
 * ModeWeightProfile entry and a real ScoringWeights entry.
 *
 * Operator: `Math.max(base[scoringField], mode[modeField])` for the floor
 * step. Optional per-mode caps are applied afterwards when a lane must
 * suppress a signal entirely.
 */
export const MODE_WEIGHT_OVERLAY_MAP: ReadonlyArray<{
  readonly modeField: keyof ModeWeightProfile;
  readonly scoringField: keyof ScoringWeights;
}> = [
  { modeField: 'entityIntegrityWeight', scoringField: 'entityIntegrity' },
  { modeField: 'anchorSimilarityWeight', scoringField: 'anchorSimilarity' },
  { modeField: 'semanticWeight', scoringField: 'semantic' },
  { modeField: 'softConstraintWeight', scoringField: 'softConstraint' },
  { modeField: 'attributeAlignmentWeight', scoringField: 'attributeAlignment' },
  { modeField: 'preferenceAlignmentWeight', scoringField: 'preferenceAlignment' },
  { modeField: 'popularityWeight', scoringField: 'popularity' },
  { modeField: 'availabilityWeight', scoringField: 'availability' },
  { modeField: 'producerPrestigeWeight', scoringField: 'producerPrestige' },
  { modeField: 'recencyWeight', scoringField: 'recency' },
  { modeField: 'criticScoreWeight', scoringField: 'criticScore' },
  { modeField: 'multilingualScoreWeight', scoringField: 'multilingualScore' },
  { modeField: 'giftSuitabilityWeight', scoringField: 'giftSuitability' },
  { modeField: 'beginnerSuitabilityWeight', scoringField: 'beginnerSuitability' },
] as const;

const MODE_WEIGHT_CAP_PROFILES: Partial<Readonly<Record<RetrievalMode, Partial<ScoringWeights>>>> = {
  attribute_search: {
    producerPrestige: 0,
    criticScore: 0,
    multilingualScore: 0,
    availability: 0,
  },
  constraint_filter: {
    producerPrestige: 0,
    criticScore: 0,
    multilingualScore: 0,
    availability: 0,
  },
} as const;

/**
 * Apply a `ModeWeightProfile` overlay to a `ScoringWeights` base via
 * `Math.max` per field defined in {@link MODE_WEIGHT_OVERLAY_MAP}, then
 * optional per-mode caps. This is the only allowed overlay surface —
 * ranker.ts and any test helper MUST call this rather than re-implementing
 * the chain (RCA5-04 history: a hand-rolled overlay silently dropped fields,
 * and generic sensory lanes leaked prestige/critic residuals).
 */
export function applyModeWeightOverlay(
  base: ScoringWeights,
  mode: ModeWeightProfile,
  retrievalMode?: RetrievalMode,
): ScoringWeights {
  const next: ScoringWeights = { ...base };
  for (const { modeField, scoringField } of MODE_WEIGHT_OVERLAY_MAP) {
    (next as unknown as Record<string, number>)[scoringField] = Math.max(
      base[scoringField],
      mode[modeField],
    );
  }
  const caps = retrievalMode !== undefined ? MODE_WEIGHT_CAP_PROFILES[retrievalMode] : undefined;
  if (caps !== undefined) {
    for (const [scoringField, cap] of Object.entries(caps) as ReadonlyArray<[keyof ScoringWeights, number]>) {
      (next as unknown as Record<string, number>)[scoringField] = Math.min(next[scoringField], cap);
    }
  }
  return next;
}

/**
 * Scale every overlaid field by `factor`. Used by ranker.ts to renormalise
 * an overlaid weight set so the non-penalty sum is preserved (Math.max can
 * inflate the total). Iterates the same SSoT map so the scale set cannot
 * drift from the overlay set.
 */
export function scaleOverlaidWeights(
  overlaid: ScoringWeights,
  factor: number,
): ScoringWeights {
  if (factor === 1) return overlaid;
  const next: ScoringWeights = { ...overlaid };
  for (const { scoringField } of MODE_WEIGHT_OVERLAY_MAP) {
    (next as unknown as Record<string, number>)[scoringField] = overlaid[scoringField] * factor;
  }
  return next;
}
