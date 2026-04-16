import type {
  ConstraintBundle,
  QueryClass,
} from '../../shared/types/index.js';
import {
  type RetrievalChannel,
  preferCanonicalRetrievalChannelLabels,
} from '../../retrieval/model/retrieval-channel.js';

/** Redistribute mass toward anchor similarity when anchor channel active. */
const CHANNEL_WEIGHT_ANCHOR_SIMILARITY_BOOST = 1.3;
/** Down-weight semantic when anchor channel steals mass (paired boost). */
const CHANNEL_WEIGHT_SEMANTIC_ANCHOR_PAIR_DIVISOR = 1.3;
/** Slight semantic up-weight when learned sparse retrieval present. */
const CHANNEL_WEIGHT_SEMANTIC_LEARNED_SPARSE_BOOST = 1.1;
/** Soft-constraint emphasis under relative filter retrieval. */
const CHANNEL_WEIGHT_SOFT_CONSTRAINT_RELATIVE_FILTER_BOOST = 1.2;
/** Attribute alignment emphasis when only sparse BM25 fires. */
const CHANNEL_WEIGHT_ATTRIBUTE_SPARSE_ONLY_BOOST = 1.2;

/**
 * Weight configuration for the score aggregation formula.
 *
 * Non-gate signals are normalized so their weights sum to approximately 1.0.
 * Gate signals (hard constraint pass, entity integrity threshold) are handled
 * separately as pass/fail before weighted aggregation.
 */
export interface ScoringWeights {
  /** Weight for entity integrity signal. */
  readonly entityIntegrity: number;

  /** Weight for anchor similarity signal (only meaningful for anchored queries). */
  readonly anchorSimilarity: number;

  /** Weight for semantic relevance signal. */
  readonly semantic: number;

  /** Weight for soft constraint satisfaction. */
  readonly softConstraint: number;

  /** Weight for structured attribute alignment. */
  readonly attributeAlignment: number;

  /** Weight for user preference alignment. */
  readonly preferenceAlignment: number;

  /** Weight for popularity signal (intentionally small — tie-breaker level). */
  readonly popularity: number;

  /** Weight for availability signal. */
  readonly availability: number;

  /** Weight for uncertainty penalty (applied as subtraction). */
  readonly uncertaintyPenalty: number;

  /**
   * Minimum entity integrity score below which the candidate is removed.
   * Acts as a gate similar to hard constraints.
   */
  readonly entityIntegrityThreshold: number;

  /** Weight for producer prestige signal (producer_browse, region_browse, compare). */
  readonly producerPrestige: number;

  /** Weight for vintage recency signal (browse / comparison modes). */
  readonly recency: number;

  /** Weight for critic score signal (recommendation, attribute_search modes). */
  readonly criticScore: number;

  /** Weight for multilingual (Korean) match signal. */
  readonly multilingualScore: number;

  /** Weight for gift suitability signal (situation_based queries with gift intent). */
  readonly giftSuitability: number;

  /** Weight for beginner suitability signal (situation_based queries with beginner intent). */
  readonly beginnerSuitability: number;
}

/**
 * Default scoring weights for general queries.
 * Non-penalty weights (all except uncertaintyPenalty) sum to ~0.95; total
 * including the penalty weight sums to ~1.0. Query-class overrides
 * (e.g. anchored_similarity, semantic_preference) follow the same convention
 * but some totals reach ~1.05 when penalty weight is included — this is
 * intentional and handled by resolveChannelAwareWeights() proportional
 * normalization.
 */
const DEFAULT_WEIGHTS: ScoringWeights = {
  entityIntegrity: 0.15,
  anchorSimilarity: 0.0,
  semantic: 0.25,
  softConstraint: 0.20,
  attributeAlignment: 0.15,
  preferenceAlignment: 0.10,
  popularity: 0.03,
  availability: 0.07,
  uncertaintyPenalty: 0.05,
  entityIntegrityThreshold: 0.3,
  producerPrestige: 0.0,
  recency: 0.0,
  criticScore: 0.0,
  multilingualScore: 0.0,
  giftSuitability: 0.0,
  beginnerSuitability: 0.0,
} as const;

/**
 * Query-class-specific weight overrides.
 *
 * Each override is a partial set of weights that will be merged with
 * {@link DEFAULT_WEIGHTS}. For example, `anchored_similarity` raises the
 * anchor weight and lowers semantic weight to prevent embedding similarity
 * from dominating (RFC-013 rule 5).
 */
const QUERY_CLASS_OVERRIDES: Readonly<Partial<Record<QueryClass, Partial<ScoringWeights>>>> = {
  anchored_similarity: {
    anchorSimilarity: 0.30,
    semantic: 0.10,
    softConstraint: 0.15,
    attributeAlignment: 0.10,
    preferenceAlignment: 0.10,
    entityIntegrity: 0.10,
    popularity: 0.02,
    availability: 0.08,
    uncertaintyPenalty: 0.05,
    producerPrestige: 0.0,
    recency: 0.0,
    criticScore: 0.0,
    multilingualScore: 0.05,
    giftSuitability: 0.0,
    beginnerSuitability: 0.0,
  },
  pure_constraint: {
    softConstraint: 0.32,    // non-penalty sum: 0.32+0.27+0.04+0.10+0.02+0.01+0.07+0.05 = 0.88
    attributeAlignment: 0.27,
    semantic: 0.04,          // reduced from 0.10 — pure constraint queries rely on explicit constraints, not embedding similarity
    entityIntegrity: 0.10,
    preferenceAlignment: 0.02, // reduced from 0.05 — situation queries have explicit constraints rather than soft preferences
    popularity: 0.01,        // reduced from 0.03 — popularity is a weak signal for situation queries
    availability: 0.07,
    uncertaintyPenalty: 0.05,
    producerPrestige: 0.0,
    recency: 0.0,
    criticScore: 0.05,
    multilingualScore: 0.0,
    giftSuitability: 0.0,
    beginnerSuitability: 0.0,
  },
  semantic_preference: {
    semantic: 0.22,
    preferenceAlignment: 0.20,
    softConstraint: 0.10,
    attributeAlignment: 0.10,
    entityIntegrity: 0.10,
    popularity: 0.01,
    availability: 0.05,
    uncertaintyPenalty: 0.05,
    producerPrestige: 0.02,
    recency: 0.0,
    criticScore: 0.10,
    multilingualScore: 0.05,
    giftSuitability: 0.0,
    beginnerSuitability: 0.0,
  },
  short_entity: {
    entityIntegrity: 0.30,
    attributeAlignment: 0.25,
    semantic: 0.15,
    softConstraint: 0.10,
    preferenceAlignment: 0.05,
    popularity: 0.03,
    availability: 0.07,
    uncertaintyPenalty: 0.05,
    producerPrestige: 0.0,
    recency: 0.0,
    criticScore: 0.0,
    multilingualScore: 0.0,
    giftSuitability: 0.0,
    beginnerSuitability: 0.0,
  },
  // exact_entity: fully specified lookup — same weight profile as short_entity;
  // entity integrity and attribute alignment dominate.
  exact_entity: {
    entityIntegrity: 0.30,
    attributeAlignment: 0.25,
    semantic: 0.15,
    softConstraint: 0.10,
    preferenceAlignment: 0.05,
    popularity: 0.03,
    availability: 0.07,
    uncertaintyPenalty: 0.05,
    producerPrestige: 0.0,
    recency: 0.0,
    criticScore: 0.0,
    multilingualScore: 0.0,
    giftSuitability: 0.0,
    beginnerSuitability: 0.0,
  },
  ambiguous_short_form: {
    entityIntegrity: 0.25,
    semantic: 0.20,
    attributeAlignment: 0.20,
    softConstraint: 0.10,
    preferenceAlignment: 0.05,
    popularity: 0.03,
    availability: 0.07,
    uncertaintyPenalty: 0.10,
    producerPrestige: 0.0,
    recency: 0.0,
    criticScore: 0.0,
    multilingualScore: 0.0,
    giftSuitability: 0.0,
    beginnerSuitability: 0.0,
  },
  comparison_query: {
    entityIntegrity: 0.20,
    attributeAlignment: 0.15,
    semantic: 0.15,
    softConstraint: 0.10,
    preferenceAlignment: 0.03,
    popularity: 0.02,
    availability: 0.05,
    uncertaintyPenalty: 0.05,
    producerPrestige: 0.10,  // prestige matters for head-to-head comparisons
    recency: 0.05,           // vintage recency relevant for comparison
    criticScore: 0.10,       // critic score is key for comparison queries
    multilingualScore: 0.0,
    giftSuitability: 0.0,
    beginnerSuitability: 0.0,
  },
} as const;

/**
 * Resolves the effective scoring weights for a given query class.
 *
 * Merges query-class-specific overrides on top of the default weights.
 * If no override exists for the given class, the defaults are returned as-is.
 *
 * @param queryClass - The query classification label.
 * @returns The resolved scoring weights.
 */
export function resolveWeights(queryClass: QueryClass): ScoringWeights {
  const overrides = QUERY_CLASS_OVERRIDES[queryClass];
  if (overrides === undefined) {
    return DEFAULT_WEIGHTS;
  }
  return { ...DEFAULT_WEIGHTS, ...overrides };
}

export { DEFAULT_WEIGHTS };

const SITUATION_INTENT_GIFT_WEIGHT_FLOOR = 0.15;
const SITUATION_INTENT_BEGINNER_WEIGHT_FLOOR = 0.15;

function constraintValueMatches(
  constraints: ConstraintBundle,
  attribute: string,
  expectedValue: string,
): boolean {
  const buckets = [constraints.hard, constraints.soft, constraints.inferred] as const;
  for (const bucket of buckets) {
    for (const constraint of bucket) {
      if (constraint.attribute !== attribute) continue;
      const value = constraint.value;
      if (typeof value === 'string' && value === expectedValue) {
        return true;
      }
      if (Array.isArray(value) && value.includes(expectedValue)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Applies a query-constraint-driven overlay for explicit situation intents.
 *
 * This is deliberately narrower than the mode overlay: it only activates when
 * the parsed query already surfaced a supported situation facet in the
 * constraint bundle. No raw-text heuristics are used here.
 */
export function applySituationIntentWeightOverlay(
  baseWeights: ScoringWeights,
  constraints: ConstraintBundle,
): ScoringWeights {
  const hasGiftIntent = constraintValueMatches(constraints, 'occasion', 'gift');
  const hasBeginnerIntent = constraintValueMatches(constraints, 'style', 'approachable');

  if (!hasGiftIntent && !hasBeginnerIntent) {
    return baseWeights;
  }

  const giftSuitability = hasGiftIntent
    ? Math.max(baseWeights.giftSuitability, SITUATION_INTENT_GIFT_WEIGHT_FLOOR)
    : baseWeights.giftSuitability;
  const beginnerSuitability = hasBeginnerIntent
    ? Math.max(baseWeights.beginnerSuitability, SITUATION_INTENT_BEGINNER_WEIGHT_FLOOR)
    : baseWeights.beginnerSuitability;

  const baseNonPenaltySum =
    baseWeights.entityIntegrity +
    baseWeights.anchorSimilarity +
    baseWeights.semantic +
    baseWeights.softConstraint +
    baseWeights.attributeAlignment +
    baseWeights.preferenceAlignment +
    baseWeights.popularity +
    baseWeights.availability +
    baseWeights.producerPrestige +
    baseWeights.recency +
    baseWeights.criticScore +
    baseWeights.multilingualScore +
    baseWeights.giftSuitability +
    baseWeights.beginnerSuitability;

  const adjustedNonPenaltySum =
    baseWeights.entityIntegrity +
    baseWeights.anchorSimilarity +
    baseWeights.semantic +
    baseWeights.softConstraint +
    baseWeights.attributeAlignment +
    baseWeights.preferenceAlignment +
    baseWeights.popularity +
    baseWeights.availability +
    baseWeights.producerPrestige +
    baseWeights.recency +
    baseWeights.criticScore +
    baseWeights.multilingualScore +
    giftSuitability +
    beginnerSuitability;

  const rawNormFactor = adjustedNonPenaltySum > 0 ? baseNonPenaltySum / adjustedNonPenaltySum : 1;
  const normFactor = Number.isFinite(rawNormFactor) ? rawNormFactor : 1;

  return {
    entityIntegrity: baseWeights.entityIntegrity * normFactor,
    anchorSimilarity: baseWeights.anchorSimilarity * normFactor,
    semantic: baseWeights.semantic * normFactor,
    softConstraint: baseWeights.softConstraint * normFactor,
    attributeAlignment: baseWeights.attributeAlignment * normFactor,
    preferenceAlignment: baseWeights.preferenceAlignment * normFactor,
    popularity: baseWeights.popularity * normFactor,
    availability: baseWeights.availability * normFactor,
    uncertaintyPenalty: baseWeights.uncertaintyPenalty,
    entityIntegrityThreshold: baseWeights.entityIntegrityThreshold,
    producerPrestige: baseWeights.producerPrestige * normFactor,
    recency: baseWeights.recency * normFactor,
    criticScore: baseWeights.criticScore * normFactor,
    multilingualScore: baseWeights.multilingualScore * normFactor,
    giftSuitability: giftSuitability * normFactor,
    beginnerSuitability: beginnerSuitability * normFactor,
  };
}

/**
 * Adjusts scoring weights based on which retrieval channels contributed to a
 * specific candidate. The adjusted weights are then normalized proportionally
 * so the total weight sum is preserved — preventing calibration drift while
 * still shifting relative emphasis toward the signals that channels make more
 * precise.
 *
 * Rules (applied in order, adjustments are multiplicative on base weights):
 *  - `anchor_similarity` or `compare_anchor` → boost `anchorSimilarity` × 1.3,
 *    reduce `semantic` by the reciprocal factor (÷ 1.3).
 *  - `learned_sparse` → boost `semantic` × 1.1 (learned sparse improves precision).
 *  - `relative_filter` → boost `softConstraint` × 1.2.
 *  - Only `sparse_bm25` (no dense channel) → boost `attributeAlignment` × 1.2.
 *
 * After all adjustments the non-gate weights are normalised proportionally so
 * they sum to the same total as the input weights — preserving ranking
 * calibration across query classes.
 *
 * Gate-only fields (`entityIntegrityThreshold`) are never adjusted.
 *
 * @param channels - Retrieval channels that contributed to this candidate.
 * @param baseWeights - Query-class-resolved weights (output of {@link resolveWeights}).
 * @returns Channel-adjusted, proportionally-normalised weights.
 */
export function resolveChannelAwareWeights(
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  channels: readonly (RetrievalChannel | string)[],
  baseWeights: ScoringWeights,
): ScoringWeights {
  const channelSet = new Set(preferCanonicalRetrievalChannelLabels(channels));

  const hasAnchorChannel =
    channelSet.has('anchor_similarity') || channelSet.has('compare_anchor');
  const hasLearnedSparse = channelSet.has('learned_sparse');
  const hasRelativeFilter = channelSet.has('relative_filter');

  // "Only sparse_bm25, no dense" — none of the dense/semantic family is present.
  const hasDenseChannel =
    channelSet.has('dense_semantic') ||
    channelSet.has('anchor_similarity') ||
    channelSet.has('compare_anchor');
  const onlySparseBm25 = channelSet.has('sparse_bm25') && !hasDenseChannel;

  // Start from base weights (mutable copy of the numeric knobs).
  let anchorSimilarity = baseWeights.anchorSimilarity;
  let semantic = baseWeights.semantic;
  let softConstraint = baseWeights.softConstraint;
  let attributeAlignment = baseWeights.attributeAlignment;
  const entityIntegrity = baseWeights.entityIntegrity;
  const preferenceAlignment = baseWeights.preferenceAlignment;
  const popularity = baseWeights.popularity;
  const availability = baseWeights.availability;
  const uncertaintyPenalty = baseWeights.uncertaintyPenalty;
  // New SOTA++ weights — not channel-adjusted (domain signals, not retrieval signals)
  const producerPrestige = baseWeights.producerPrestige;
  const recency = baseWeights.recency;
  const criticScore = baseWeights.criticScore;
  const multilingualScore = baseWeights.multilingualScore;
  // Track C learned facet signals — not channel-adjusted (domain signals from ETL)
  const giftSuitability = baseWeights.giftSuitability;
  const beginnerSuitability = baseWeights.beginnerSuitability;

  if (hasAnchorChannel) {
    anchorSimilarity *= CHANNEL_WEIGHT_ANCHOR_SIMILARITY_BOOST;
    semantic /= CHANNEL_WEIGHT_SEMANTIC_ANCHOR_PAIR_DIVISOR;
  }
  if (hasLearnedSparse) {
    semantic *= CHANNEL_WEIGHT_SEMANTIC_LEARNED_SPARSE_BOOST;
  }
  if (hasRelativeFilter) {
    softConstraint *= CHANNEL_WEIGHT_SOFT_CONSTRAINT_RELATIVE_FILTER_BOOST;
  }
  if (onlySparseBm25) {
    attributeAlignment *= CHANNEL_WEIGHT_ATTRIBUTE_SPARSE_ONLY_BOOST;
  }

  // Proportional normalisation — preserve total of non-gate, non-penalty weights.
  // New SOTA++ weights (producerPrestige, recency, criticScore, multilingualScore)
  // are included in both base and adjusted sums so the norm factor accounts for them.
  const baseNonPenaltySum =
    baseWeights.entityIntegrity +
    baseWeights.anchorSimilarity +
    baseWeights.semantic +
    baseWeights.softConstraint +
    baseWeights.attributeAlignment +
    baseWeights.preferenceAlignment +
    baseWeights.popularity +
    baseWeights.availability +
    baseWeights.producerPrestige +
    baseWeights.recency +
    baseWeights.criticScore +
    baseWeights.multilingualScore +
    baseWeights.giftSuitability +
    baseWeights.beginnerSuitability;

  const adjustedNonPenaltySum =
    entityIntegrity +
    anchorSimilarity +
    semantic +
    softConstraint +
    attributeAlignment +
    preferenceAlignment +
    popularity +
    availability +
    producerPrestige +
    recency +
    criticScore +
    multilingualScore +
    giftSuitability +
    beginnerSuitability;

  // Guard: if there is nothing to normalise (all weights are zero) return as-is.
  const rawNormFactor =
    adjustedNonPenaltySum > 0
      ? baseNonPenaltySum / adjustedNonPenaltySum
      : 1;
  const normFactor = Number.isFinite(rawNormFactor) ? rawNormFactor : 1;

  return {
    entityIntegrity: entityIntegrity * normFactor,
    anchorSimilarity: anchorSimilarity * normFactor,
    semantic: semantic * normFactor,
    softConstraint: softConstraint * normFactor,
    attributeAlignment: attributeAlignment * normFactor,
    preferenceAlignment: preferenceAlignment * normFactor,
    popularity: popularity * normFactor,
    availability: availability * normFactor,
    uncertaintyPenalty,
    entityIntegrityThreshold: baseWeights.entityIntegrityThreshold,
    producerPrestige: producerPrestige * normFactor,
    recency: recency * normFactor,
    criticScore: criticScore * normFactor,
    multilingualScore: multilingualScore * normFactor,
    giftSuitability: giftSuitability * normFactor,
    beginnerSuitability: beginnerSuitability * normFactor,
  };
}
