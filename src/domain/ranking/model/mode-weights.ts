/**
 * Epic 7: Retrieval Mode-specific Scoring Weights
 *
 * Maps RetrievalMode to optimized ranking weight profiles.
 * Used to adjust relevance signals based on query intent.
 *
 * RFC-017 §8.3: Different modes use different ranking strategies.
 */

import type { RetrievalMode } from '../../query/model/retrieval-mode.js';

/**
 * Ranking weight profile for a retrieval mode.
 *
 * **Invariants** (enforced by `mode-weights.test.ts`):
 *   1. Every weight ∈ [0, 1].
 *   2. Every `RetrievalMode` enum value has a profile in `MODE_WEIGHT_PROFILES`.
 *   3. `DEFAULT_WEIGHTS` is all-zero so `Math.max(base, default) = base`.
 *
 * **Non-invariant**: profile fields do NOT sum to 1.0. Each weight is an
 * independent overlay applied via `Math.max(baseWeight, modeWeight)` in
 * `ranker.ts`, so they can collectively exceed 1.0 — that's intentional.
 * Tuning a single weight changes only that signal's floor.
 *
 * All 15 non-penalty ScoringWeights fields have a corresponding entry so
 * the mode overlay in ranker.ts can apply Math.max() across all fields
 * without silently leaving 6 fields unadjusted (RCA5-04).
 */
export interface ModeWeightProfile {
  /** How much to weight BM25 lexical match (maps to no direct ScoringWeights field; used by anchorSimilarity overlay). */
  readonly lexicalWeight: number;

  /** How much to weight semantic embedding similarity. */
  readonly semanticWeight: number;

  /** How much to weight popularity/critic scores. */
  readonly popularityWeight: number;

  /** How much to weight entity integrity (matching exact type/category). */
  readonly entityIntegrityWeight: number;

  /** How much to weight attribute alignment (for filtered searches). */
  readonly attributeAlignmentWeight: number;

  /** How much to weight diversity (penalize same-producer clustering). */
  readonly diversityWeight: number;

  /** For comparisons and browses: prefer recently indexed/updated documents. */
  readonly recencyWeight: number;

  /** For producer browse: emphasize producer prestige/reputation. */
  readonly producerPrestigeWeight: number;

  /** For region browse: emphasize geographic/appellation alignment. */
  readonly geographicAlignmentWeight: number;

  /** For recommendations: emphasize preference alignment (pairing, occasion). */
  readonly preferenceAlignmentWeight: number;

  // ── Previously missing fields (RCA5-04: only 6/12 fields were overlaid) ──

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
}

/**
 * No-op fallback used when retrievalMode is undefined or unrecognised.
 * All values are 0.0 so Math.max(baseWeight, 0) = baseWeight — the
 * query-class weights are preserved exactly with no mode interference.
 */
export const DEFAULT_WEIGHTS: ModeWeightProfile = {
  lexicalWeight: 0.0,
  semanticWeight: 0.0,
  popularityWeight: 0.0,
  entityIntegrityWeight: 0.0,
  attributeAlignmentWeight: 0.0,
  diversityWeight: 0.0,
  recencyWeight: 0.0,
  producerPrestigeWeight: 0.0,
  geographicAlignmentWeight: 0.0,
  preferenceAlignmentWeight: 0.0,
  anchorSimilarityWeight: 0.0,
  softConstraintWeight: 0.0,
  availabilityWeight: 0.0,
  criticScoreWeight: 0.0,
  multilingualScoreWeight: 0.0,
};

/**
 * Mode-to-weight-profile mapping.
 * Each mode overrides specific weights to optimize for its query intent.
 */
const MODE_WEIGHT_PROFILES: Record<RetrievalMode, ModeWeightProfile> = {
  // === Exact entity lookup: highest confidence in BM25 ===
  entity_lookup: {
    lexicalWeight: 0.75,          // Strong emphasis on exact name match
    semanticWeight: 0.15,         // Secondary fallback to embedding
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.08,  // Exact type match important
    attributeAlignmentWeight: 0.02,
    diversityWeight: 0.0,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
  },

  // === Ambiguous entity: boost confidence thresholds ===
  entity_resolution: {
    lexicalWeight: 0.50,          // Moderate BM25 (don't over-commit)
    semanticWeight: 0.30,         // Embedding provides tie-breaking
    popularityWeight: 0.10,        // Popularity as tertiary signal
    entityIntegrityWeight: 0.10,  // Extra emphasis on entity type matching
    attributeAlignmentWeight: 0.0,
    diversityWeight: 0.0,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
  },

  // === Attribute search: balance text + semantic ===
  attribute_search: {
    lexicalWeight: 0.50,
    semanticWeight: 0.35,
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.03,
    attributeAlignmentWeight: 0.10,  // Constraints matter
    diversityWeight: 0.02,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
  },

  // === Constraint filtering: favor constraint adherence ===
  constraint_filter: {
    lexicalWeight: 0.30,
    semanticWeight: 0.20,
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.05,
    attributeAlignmentWeight: 0.35,  // Heavily favor attribute match
    diversityWeight: 0.0,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.20,      // Soft constraints matter in filter mode
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
  },

  // === Producer browse: high diversity, prestige-aware ===
  producer_browse: {
    lexicalWeight: 0.40,
    semanticWeight: 0.20,
    popularityWeight: 0.15,
    entityIntegrityWeight: 0.05,
    attributeAlignmentWeight: 0.10,
    diversityWeight: 0.15,              // Penalize same-vintage clustering
    recencyWeight: 0.05,
    producerPrestigeWeight: 0.10,       // Producer reputation matters
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.05,            // Critic score secondary for browse
    multilingualScoreWeight: 0.0,
  },

  // === Region browse: geographic alignment ===
  region_browse: {
    lexicalWeight: 0.30,
    semanticWeight: 0.25,
    popularityWeight: 0.15,
    entityIntegrityWeight: 0.05,
    attributeAlignmentWeight: 0.15,
    diversityWeight: 0.10,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.05,
    geographicAlignmentWeight: 0.20,   // Region/appellation critical
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
  },

  // === Comparison: entity integrity paramount ===
  compare_candidates: {
    lexicalWeight: 0.50,
    semanticWeight: 0.20,
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.20,        // Must be truly comparable wines
    attributeAlignmentWeight: 0.15,     // Attributes matter for comparison
    diversityWeight: 0.0,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.05,
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.20,       // Anchor similarity key for comparison
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.10,            // Critic score key for comparison
    multilingualScoreWeight: 0.0,
  },

  // === Recommendation/pairing: preference & occasion focus ===
  recommendation: {
    lexicalWeight: 0.30,
    semanticWeight: 0.40,              // Semantic understanding of taste
    popularityWeight: 0.15,
    entityIntegrityWeight: 0.03,
    attributeAlignmentWeight: 0.17,    // Style/pairing constraints
    diversityWeight: 0.05,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.25,   // Occasion/pairing preference
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.15,        // Soft constraints (pairing tags) important
    availabilityWeight: 0.0,
    criticScoreWeight: 0.10,           // Quality signals for recommendations
    multilingualScoreWeight: 0.0,
  },

  // === Similar items: anchor-based similarity (mixed route) ===
  similar_items: {
    lexicalWeight: 0.20,
    semanticWeight: 0.50,              // Embedding is primary signal
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.05,
    attributeAlignmentWeight: 0.08,
    diversityWeight: 0.12,             // Avoid anchor-exact duplicates
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.30,      // Anchor similarity is the main signal
    softConstraintWeight: 0.10,        // Constraint satisfaction secondary
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
  },

  // === No match: fallback (should rarely be reached in ranking) ===
  no_match_detection: {
    lexicalWeight: 0.70,               // Try to find any mention
    semanticWeight: 0.20,
    popularityWeight: 0.10,
    entityIntegrityWeight: 0.0,
    attributeAlignmentWeight: 0.0,
    diversityWeight: 0.0,
    recencyWeight: 0.0,
    producerPrestigeWeight: 0.0,
    geographicAlignmentWeight: 0.0,
    preferenceAlignmentWeight: 0.0,
    anchorSimilarityWeight: 0.0,
    softConstraintWeight: 0.0,
    availabilityWeight: 0.0,
    criticScoreWeight: 0.0,
    multilingualScoreWeight: 0.0,
  },
};

/**
 * Returns the weight profile for a given retrieval mode.
 * Falls back to DEFAULT_WEIGHTS for unknown or missing modes.
 */
export function getModeWeights(mode: RetrievalMode | undefined): ModeWeightProfile {
  return (mode !== undefined ? MODE_WEIGHT_PROFILES[mode] : undefined) ?? DEFAULT_WEIGHTS;
}
