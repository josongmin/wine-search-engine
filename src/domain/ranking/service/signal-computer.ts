import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { AnchorProfile } from '../../retrieval/model/retrieval-input.js';
import type { RetrievalPlan } from '../../retrieval/service/retrieval-plan-builder.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
import type { ComponentScores } from '../model/ranked-result.js';
import { clamp01 } from '../../shared/utils/clamp.js';

/**
 * Minimum entity integrity score to be considered viable.
 * Below this, the candidate is likely a type/vintage/producer mismatch.
 */
const INTEGRITY_BASE = 1.0;

/**
 * Penalty applied to entity integrity when the candidate has unmet hard constraints
 * that indicate a fundamental type mismatch (e.g. red wine when white was requested).
 */
const TYPE_MISMATCH_PENALTY = 0.6;

/**
 * Penalty per unmet hard constraint that is not a type mismatch.
 */
const GENERIC_UNMET_PENALTY = 0.2;

/** Scales constraint match ratio bonus in entity integrity [0,1]. */
const CONSTRAINT_MATCH_RATIO_BONUS_SCALE = 0.1;
/** Penalty when query has anchors but candidate lacks anchor rank. */
const MISSING_ANCHOR_RANK_PENALTY = 0.1;
/** Inferred constraints contribute at this fraction of listed confidence. */
const INFERRED_CONSTRAINT_WEIGHT_FACTOR = 0.5;
/**
 * Neutral attribute alignment when the plan specifies no structured attrs.
 *
 * Domain rationale: when the query has no structured constraints (e.g. a
 * free-text entity query like "opus one"), attribute alignment is undefined.
 * 0.5 is the sigmoid midpoint so it contributes zero net ranking pressure.
 * This is correct: without constraints there is nothing to align against.
 */
const ATTRIBUTE_ALIGNMENT_NEUTRAL = 0.5;
/** Sigmoid steepness mapping raw RRF-style fusion to (0,1). */
const SEMANTIC_SIGMOID_STEEPNESS = 10;
/** RRF-style fusion value at sigmoid inflection (tuned for typical scores). */
const SEMANTIC_SIGMOID_MIDPOINT = 0.05;
/**
 * Semantic score for candidates that did not go through fusion (browse/compare).
 * sigmoid(midpoint) ≈ 0.5 — neutral, no ranking pressure.
 */
const SEMANTIC_SCORE_NEUTRAL_WHEN_UNFUSED = 0.5;
/**
 * Popularity baseline when BM25 sparse rank is unavailable.
 *
 * Domain rationale: absence of sparse rank means the candidate came
 * exclusively from the dense channel (embedding-only hit). Such candidates
 * have no lexical popularity signal but are semantically relevant. 0.3
 * is below the median sparse-rank popularity (~0.5 at rank 3) but above
 * zero, so dense-only candidates are mildly demoted rather than crushed.
 * The asymmetry toward demotion reflects that BM25 absence usually
 * correlates with lower catalog prominence.
 */
const POPULARITY_NO_SPARSE_BASELINE = 0.3;
/** Blend: query-level uncertainty weight. */
const UNCERTAINTY_BLEND_QUERY_WEIGHT = 0.6;
/** Blend: candidate unmatched-ratio weight. */
const UNCERTAINTY_BLEND_CANDIDATE_WEIGHT = 0.4;
/** Caps contribution from unmatched constraint ratio to uncertainty penalty. */
const UNCERTAINTY_UNMATCHED_RATIO_SCALE = 0.5;
/**
 * IDX-06: preferenceAlignment always returns this neutral value.
 *
 * Investigation finding: the preferenceAlignment signal IS wired into the
 * ranking pipeline (score-aggregator.ts, ranker.ts) and IS included in
 * ComponentScores, but signal-computer.ts always returns the neutral 0.5
 * because there is no user history / preference profile available at
 * query time. This is NOT dead code — it contributes 0 net ranking pressure
 * (sigmoid midpoint), which is correct behavior until Epic-18 user history
 * wiring is complete.
 *
 * TODO(IDX-06): wire to pg-feedback-repository user preference aggregations
 * once Epic-18 click pipeline is live. The scoring formula is already in
 * place; only the data source (UserPreferencePort) is missing.
 */
const PREFERENCE_ALIGNMENT_NEUTRAL = 0.5;
/**
 * Vintage recency half-life in years.
 *
 * Domain rationale: wine aging curves peak at ~5-15 years for most fine
 * wines (Bordeaux, Barolo), with collectible vintages relevant for 20-30+
 * years. 8 years gives a half-life that keeps 5-year-old vintages at 0.65
 * and 15-year-old vintages at 0.27, matching the typical search interest
 * curve observed in query logs (most searches target 3-10 year old wines).
 * Paired with ln(2)/8 decay in computeRecency.
 */
const RECENCY_HALF_LIFE_YEARS = 8;
/** Region match weight in anchor preservation score. */
const ANCHOR_PRESERVE_REGION_WEIGHT = 0.25;
/** Primary grape match weight in anchor preservation score. */
const ANCHOR_PRESERVE_GRAPE_WEIGHT = 0.2;
/** Body / tannin style axis weights (paired). */
const ANCHOR_PRESERVE_BODY_WEIGHT = 0.15;
const ANCHOR_PRESERVE_TANNIN_WEIGHT = 0.15;
/** Acidity axis weight in anchor preservation. */
const ANCHOR_PRESERVE_ACIDITY_WEIGHT = 0.1;
/** Sweetness axis weight in anchor preservation. */
const ANCHOR_PRESERVE_SWEETNESS_WEIGHT = 0.05;
/** Retrieval fusion floor for “has signal” in preservation fallback. */
const ANCHOR_PRESERVE_RETRIEVAL_SIGNAL_FLOOR = 0.05;
/** Fallback preservation when metadata is missing but retrieval is strong. */
const ANCHOR_PRESERVE_FALLBACK_HIGH = 0.6;
/** Fallback preservation when metadata and retrieval are weak. */
const ANCHOR_PRESERVE_FALLBACK_LOW = 0.4;
/** Small boost when retrieval fusion exceeds the signal floor. */
const ANCHOR_PRESERVE_RETRIEVAL_BOOST = 0.05;
/** Max structured attribute delta for 0–1 similarity (4-point style scale). */
const ATTRIBUTE_SIMILARITY_MAX_DELTA = 4;

/**
 * Computes individual signal scores for each candidate in the ranking pipeline.
 *
 * Each method produces a single signal component that feeds into the
 * {@link ScoreAggregator}. Signal values are bounded to [0, 1] unless
 * otherwise noted (e.g. hard constraint is boolean).
 *
 * This is a pure computation class with no side effects or I/O.
 */
export class SignalComputer {
  /**
   * Computes entity integrity score.
   *
   * Checks type consistency, producer match, vintage consistency, and region
   * sanity by examining how well the candidate's matched constraints align
   * with the query plan's extracted anchors and constraints.
   *
   * A candidate with unmet hard constraints suggesting fundamental mismatches
   * (wrong type, wrong producer, wrong vintage) receives heavy penalties.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param queryPlan - The query plan providing expected attributes.
   * @returns Entity integrity score in [0, 1].
   */
  computeEntityIntegrity(
    candidate: HybridCandidate,
    queryPlan: QueryPlanV1,
  ): number {
    let score = INTEGRITY_BASE;

    // Penalize unmet hard constraints — they suggest fundamental mismatches
    const unmet = candidate.unmetHardConstraints ?? [];
    for (const attr of unmet) {
      const isTypeMismatch = attr === 'wine_type' || attr === 'color';
      score -= isTypeMismatch ? TYPE_MISMATCH_PENALTY : GENERIC_UNMET_PENALTY;
    }

    // Bonus for matching many of the query plan's constraint attributes
    const totalConstraints =
      queryPlan.constraints.hard.length +
      queryPlan.constraints.soft.length;
    if (totalConstraints > 0) {
      const matchRatio = candidate.matchedConstraints.length / totalConstraints;
      score += matchRatio * CONSTRAINT_MATCH_RATIO_BONUS_SCALE;
    }

    // Penalize if there are anchors but no anchor rank (suggests non-anchor match)
    if (queryPlan.anchors.length > 0 && candidate.anchorRank === undefined) {
      score -= MISSING_ANCHOR_RANK_PENALTY;
    }

    return clamp01(score);
  }

  /**
   * Computes anchor similarity score for mixed/anchored queries.
   *
   * Combines attribute-level distance with embedding similarity relative
   * to the anchor profile.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param anchorProfile - The resolved anchor entity profile.
   * @returns Anchor similarity score in [0, 1].
   */
  computeAnchorSimilarity(
    candidate: HybridCandidate,
    anchorProfile: AnchorProfile,
  ): number {
    // Use anchor rank as a proxy for anchor similarity.
    // Lower anchor rank = higher similarity.
    const anchorRank = candidate.anchorRank;
    if (anchorRank === undefined || anchorRank <= 0) {
      return 0;
    }

    // Rank-based similarity: 1/(1 + log(rank)), rank ≥ 1 guaranteed by guard above
    const rankSimilarity = 1 / (1 + Math.log(anchorRank));

    // Scale by anchor confidence — less confident anchor means less
    // reliable similarity signal
    return clamp01(rankSimilarity * anchorProfile.anchorConfidence);
  }

  /**
   * Gate function: evaluates whether all hard constraints are satisfied.
   *
   * If any hard constraint is violated, the candidate is gated out
   * (final score = -Infinity in the aggregator).
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param constraints - The constraint bundle from the query.
   * @returns True if all hard constraints pass, false otherwise.
   */
  evaluateHardConstraints(
    candidate: HybridCandidate,
    constraints: ConstraintBundle,
    matchedSet?: ReadonlySet<string>,
  ): boolean {
    // If there are no hard constraints, the gate passes trivially
    if (constraints.hard.length === 0) {
      return true;
    }

    // If the candidate has any unmet hard constraints, it fails the gate
    const unmet = candidate.unmetHardConstraints ?? [];
    if (unmet.length > 0) {
      return false;
    }

    // Verify the candidate matches all hard constraint attributes
    const effective = matchedSet ?? new Set(candidate.matchedConstraints);
    return constraints.hard.every(
      (c: NormalizedConstraint) => effective.has(c.attribute),
    );
  }

  /**
   * Computes weighted satisfaction of soft constraints.
   *
   * Each soft constraint that is matched contributes its confidence-weighted
   * share to the total score.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param constraints - The constraint bundle from the query.
   * @returns Soft constraint satisfaction in [0, 1].
   */
  computeSoftConstraint(
    candidate: HybridCandidate,
    constraints: ConstraintBundle,
    retrievalPlan?: RetrievalPlan,
    precomputedMatchedSet?: ReadonlySet<string>,
  ): number {
    const softConstraints = constraints.soft;
    const structuredSoftBoosts = retrievalPlan?.softBoosts ?? [];
    const structuredInferredBoosts = retrievalPlan?.inferredBoosts ?? [];
    if (
      softConstraints.length === 0
      && structuredSoftBoosts.length === 0
      && structuredInferredBoosts.length === 0
    ) {
      return 1.0; // No soft constraints → perfect score
    }

    const matchedSet = precomputedMatchedSet ?? new Set(candidate.matchedConstraints);
    let weightedSum = 0;
    let totalWeight = 0;

    // Iterate directly over the source arrays to avoid allocating
    // intermediate mapped arrays (called per candidate × per constraint).
    if (structuredSoftBoosts.length > 0) {
      for (const boost of structuredSoftBoosts) {
        totalWeight += boost.weight;
        if (matchedSet.has(boost.attribute)) {
          weightedSum += boost.weight;
        }
      }
    } else {
      for (const constraint of softConstraints) {
        totalWeight += constraint.confidence;
        if (matchedSet.has(constraint.attribute)) {
          weightedSum += constraint.confidence;
        }
      }
    }

    if (structuredInferredBoosts.length > 0) {
      for (const boost of structuredInferredBoosts) {
        totalWeight += boost.weight;
        if (matchedSet.has(boost.attribute)) {
          weightedSum += boost.weight;
        }
      }
    } else {
      for (const constraint of constraints.inferred) {
        const weight = constraint.confidence * INFERRED_CONSTRAINT_WEIGHT_FACTOR;
        totalWeight += weight;
        if (matchedSet.has(constraint.attribute)) {
          weightedSum += weight;
        }
      }
    }

    return totalWeight > 0 ? clamp01(weightedSum / totalWeight) : 1.0;
  }

  /**
   * Normalizes the dense retrieval fusion score to [0, 1].
   *
   * Embedding similarity alone NEVER dominates ranking (RFC-013 rule 5).
   * The normalization uses a sigmoid to compress extreme values.
   *
   * @param candidate - The hybrid candidate with a retrieval fusion score.
   * @returns Normalized semantic score in [0, 1].
   */
  computeSemanticScore(candidate: HybridCandidate): number {
    // fusionRrfTotal is the canonical RRF total, set only by FusionService.
    // Browse/Compare candidates do not go through fusion, so fusionRrfTotal
    // is absent — in that case return the sigmoid midpoint (neutral 0.5)
    // because there is no fusion score to normalize.
    const raw = candidate.fusionRrfTotal;
    if (raw === undefined || !Number.isFinite(raw)) {
      return SEMANTIC_SCORE_NEUTRAL_WHEN_UNFUSED;
    }
    const safeRaw = raw;

    // Sigmoid normalization: 1 / (1 + exp(-k * (x - midpoint)))
    // Tuned so that typical RRF scores map to [0.2, 0.8]
    const k = SEMANTIC_SIGMOID_STEEPNESS;
    const midpoint = SEMANTIC_SIGMOID_MIDPOINT;
    const normalized = 1 / (1 + Math.exp(-k * (safeRaw - midpoint)));

    return clamp01(normalized);
  }

  /**
   * Computes structured attribute alignment between the candidate
   * and the query plan's expected attributes.
   *
   * Measures how many of the query plan's constraints and anchor
   * attributes the candidate matches at the structured level.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param queryPlan - The query plan with structured expectations.
   * @returns Attribute alignment score in [0, 1].
   */
  computeAttributeAlignment(
    candidate: HybridCandidate,
    queryPlan: QueryPlanV1,
    precomputedMatchedSet?: ReadonlySet<string>,
  ): number {
    const expectedAttributes = new Set<string>();

    // Collect all attribute names from constraints
    for (const c of queryPlan.constraints.hard) {
      expectedAttributes.add(c.attribute);
    }
    for (const c of queryPlan.constraints.soft) {
      expectedAttributes.add(c.attribute);
    }
    for (const c of queryPlan.constraints.inferred) {
      expectedAttributes.add(c.attribute);
    }

    if (expectedAttributes.size === 0) {
      // No structured expectations → neutral score
      return ATTRIBUTE_ALIGNMENT_NEUTRAL;
    }

    const matchedSet = precomputedMatchedSet ?? new Set(candidate.matchedConstraints);
    let matchCount = 0;
    for (const attr of expectedAttributes) {
      if (matchedSet.has(attr)) {
        matchCount++;
      }
    }

    // expectedAttributes.size > 0 is guaranteed by the early-return above
    // (line 309 returns ATTRIBUTE_ALIGNMENT_NEUTRAL when size === 0); the
    // Math.max duplicates the guard at the division site so semgrep
    // wine-divide-without-zero-guard is satisfied.
    return clamp01(matchCount / Math.max(1, expectedAttributes.size));
  }

  /**
   * Computes popularity signal as a tie-breaker.
   *
   * In production this would use log(click_count + purchase_count).
   * Since HybridCandidate does not carry engagement data, we derive
   * a small signal from rank position in sparse retrieval (a proxy
   * for BM25 popularity).
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @returns Popularity score in [0, 1], intentionally small.
   */
  computePopularity(candidate: HybridCandidate): number {
    // Sparse rank serves as a proxy: lower rank = more popular/relevant
    const sparseRank = candidate.sparseRank;
    if (sparseRank === undefined) {
      return POPULARITY_NO_SPARSE_BASELINE;
    }

    // log-decay: 1 / (1 + log(rank))
    return clamp01(1 / (1 + (sparseRank > 0 ? Math.log(sparseRank) : 0)));
  }

  /**
   * Computes availability signal.
   *
   * Penalizes candidates that are unavailable. Since the current
   * HybridCandidate model doesn't carry availability data, we return
   * a default high-availability score. Infrastructure adapters would
   * enrich candidates with availability before ranking.
   *
   * @param _candidate - The hybrid candidate to evaluate.
   * @returns Availability score in [0, 1]. 1.0 = fully available.
   */
  computeAvailability(_candidate: HybridCandidate): number {
    // Default: assume available. Real implementation would check
    // candidate.metadata.availability or similar enriched field.
    return 1.0;
  }

  /**
   * Computes uncertainty penalty based on query ambiguity and
   * missing information in the candidate.
   *
   * Higher uncertainty in the query plan or fewer matched constraints
   * leads to a larger penalty.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param queryPlan - The query plan with uncertainty assessment.
   * @returns Uncertainty penalty in [0, 1]. Higher = more penalty.
   */
  computeUncertaintyPenalty(
    candidate: HybridCandidate,
    queryPlan: QueryPlanV1,
  ): number {
    const queryUncertainty = queryPlan.uncertainty.overall;

    // Candidate-level uncertainty: fewer matched constraints = more uncertain
    const totalConstraints =
      queryPlan.constraints.hard.length +
      queryPlan.constraints.soft.length +
      queryPlan.constraints.inferred.length;

    let candidateUncertainty = 0;
    if (totalConstraints > 0) {
      const unmatchedRatio =
        1 - candidate.matchedConstraints.length / totalConstraints;
      candidateUncertainty = unmatchedRatio * UNCERTAINTY_UNMATCHED_RATIO_SCALE;
    }

    // Combine query-level and candidate-level uncertainty
    return clamp01(
      queryUncertainty * UNCERTAINTY_BLEND_QUERY_WEIGHT
        + candidateUncertainty * UNCERTAINTY_BLEND_CANDIDATE_WEIGHT,
    );
  }

  /**
   * Computes producer prestige signal from the candidate's indexed prestige score.
   *
   * Producer prestige is stored in Vespa as [0, 1] (winery_rating / 5).
   * When absent we return undefined so downstream stages can preserve
   * missingness instead of fabricating a neutral producer.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @returns Producer prestige in [0, 1], or undefined when absent.
   */
  computeProducerPrestige(candidate: HybridCandidate): number | undefined {
    if (candidate.producerPrestige !== undefined) {
      return clamp01(candidate.producerPrestige);
    }
    return undefined;
  }

  /**
   * Computes vintage recency signal.
   *
   * More recent vintages score higher. We use an exponential decay so that
   * wines more than 15 years old asymptote near 0 while the current year
   * scores 1.0.  The reference year is fixed at query time to avoid
   * non-determinism in tests.
   *
   * Formula: exp(-decay * max(0, referenceYear - vintageYear))
   *   decay = ln(2) / 8  → half-life of 8 years.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param referenceYear - The year against which recency is measured (usually current).
   * @returns Recency signal in [0, 1], or undefined when vintageYear is absent.
   */
  computeRecency(candidate: HybridCandidate, referenceYear: number): number | undefined {
    const vintage = candidate.vintageYear;
    if (vintage === undefined) return undefined;
    const ageDelta = Math.max(0, referenceYear - vintage);
    const decay = Math.LN2 / RECENCY_HALF_LIFE_YEARS;
    return clamp01(Math.exp(-decay * ageDelta));
  }

  /**
   * Computes critic score signal.
   *
   * Uses the criticScoreNormalized field from the Vespa index (produced by
   * Track-C step 1 or falling back to Vivino ratingAvg / 5).
   * Returns undefined when no critic signal is available so that the
   * aggregator can skip it rather than using a misleading neutral.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @returns Critic score in [0, 1], or undefined when absent.
   */
  computeCriticScore(candidate: HybridCandidate): number | undefined {
    if (candidate.criticScoreNormalized !== undefined) {
      return clamp01(candidate.criticScoreNormalized);
    }
    return undefined;
  }

  /**
   * Computes multilingual match signal.
   *
   * Returns 1.0 when the query contains Hangul AND the candidate has Korean
   * aliases (stored in search_text_ko).  Returns 0.0 in all other cases.
   * The signal acts as a precision booster for Korean-language queries rather
   * than as a penalty for non-Korean ones.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param queryContainsHangul - True when the query string contains any Korean characters.
   * @returns Multilingual signal in {0, 1}.
   */
  computeMultilingualScore(
    candidate: HybridCandidate,
    queryContainsHangul: boolean,
  ): number {
    if (!queryContainsHangul) return 0;
    // Only boost candidates that actually have Korean text/aliases indexed.
    // Returning 1 unconditionally over-rewarded all wines on Korean queries.
    return candidate.searchTextKo !== undefined && candidate.searchTextKo.length > 0 ? 1 : 0;
  }

  /**
   * Computes all signal components for a single candidate.
   *
   * Convenience method that calls each individual signal computation
   * and assembles the complete {@link ComponentScores}.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @param queryPlan - The query plan driving scoring.
   * @param constraints - The constraint bundle to enforce.
   * @param anchorProfile - Optional anchor profile for similarity scoring.
   * @param referenceYear - Year for recency computation (defaults to current year).
   * @param queryContainsHangul - Whether the original query contained Korean characters.
   * @returns The full set of component scores.
   */
  computeAll(
    candidate: HybridCandidate,
    queryPlan: QueryPlanV1,
    constraints: ConstraintBundle,
    anchorProfile?: AnchorProfile,
    retrievalPlan?: RetrievalPlan,
    referenceYear: number = new Date().getFullYear(),
    queryContainsHangul = false,
  ): ComponentScores {
    // Precompute matched constraint set once (Rule 16: avoid per-function Set allocation)
    const matchedConstraintSet = new Set(candidate.matchedConstraints);
    const recency = this.computeRecency(candidate, referenceYear);
    const criticScore = this.computeCriticScore(candidate);
    const producerPrestige = this.computeProducerPrestige(candidate);
    return {
      entityIntegrity: this.computeEntityIntegrity(candidate, queryPlan),
      anchorSimilarity: anchorProfile !== undefined
        ? this.computeAnchorSimilarity(candidate, anchorProfile)
        : undefined,
      semantic: this.computeSemanticScore(candidate),
      hardConstraintPass: this.evaluateHardConstraints(candidate, constraints, matchedConstraintSet),
      softConstraint: this.computeSoftConstraint(candidate, constraints, retrievalPlan, matchedConstraintSet),
      attributeAlignment: this.computeAttributeAlignment(candidate, queryPlan, matchedConstraintSet),
      preferenceAlignment: PREFERENCE_ALIGNMENT_NEUTRAL,
      popularity: this.computePopularity(candidate),
      availability: this.computeAvailability(candidate),
      uncertaintyPenalty: this.computeUncertaintyPenalty(candidate, queryPlan),
      ...(producerPrestige !== undefined
        ? { producerPrestige }
        : {}),
      ...(recency !== undefined ? { recency } : {}),
      ...(criticScore !== undefined ? { criticScore } : {}),
      multilingualScore: this.computeMultilingualScore(candidate, queryContainsHangul),
    };
  }

  /**
   * Epic 10: Computes set diversity signal for browse/comparison queries.
   *
   * Measures how distinct a candidate is from other candidates in the set
   * along a specified attribute dimension (e.g. vintage, producer, price band).
   *
   * Used by BrowseRetriever and CompareRetriever to ensure results don't
   * cluster (e.g. don't return three wines from the same producer in a row).
   *
   * @param candidates - The candidate set to evaluate diversity within.
   * @param focusAttribute - The attribute to measure diversity on (e.g. "vintage", "producer").
   * @returns Diversity penalty in [0, 1]. 0 = unique, 1 = duplicate in set.
   */
  computeSetDiversity(
    candidates: HybridCandidate[],
    focusAttribute: string,
  ): number {
    if (candidates.length < 2) {
      return 0; // Single item or empty → no diversity penalty
    }

    // Count how many prior candidates share the same focus attribute value.
    // This implementation intentionally uses the metadata already propagated into
    // HybridCandidate so browse/compare diversity stays deterministic and explainable
    // without requiring an extra enrichment round-trip.

    let duplicateCount = 0;
    if (focusAttribute === 'producer') {
      const producerMap = new Map<string | undefined, number>();
      for (const c of candidates) {
        const key = c.producer;
        const count = (producerMap.get(key) ?? 0) + 1;
        producerMap.set(key, count);
        if (count > 1) {
          duplicateCount++;
        }
      }
    } else if (focusAttribute === 'region') {
      const regionMap = new Map<string | undefined, number>();
      for (const c of candidates) {
        const key = c.region;
        const count = (regionMap.get(key) ?? 0) + 1;
        regionMap.set(key, count);
        if (count > 1) {
          duplicateCount++;
        }
      }
    }

    // candidates.length > 0 is guaranteed by the empty-check above; Math.max
    // duplicates the guard so semgrep wine-divide-without-zero-guard is
    // satisfied at the division site.
    return clamp01(duplicateCount / Math.max(1, candidates.length));
  }

  /**
   * Epic 10: Computes set coverage signal for browse/comparison queries.
   *
   * Measures what fraction of a target set of attribute values (e.g. price bands,
   * producer names, grape varieties) are represented in the candidate result set.
   *
   * Used to ensure browse results span the full spectrum of what's available
   * (e.g. include wines from budget, mid, premium price bands).
   *
   * @param candidates - The candidate set to evaluate coverage of.
   * @param targetSet - The desired attribute values to cover (e.g. price bands).
   * @returns Coverage score in [0, 1]. 1 = all target values represented.
   */
  computeSetCoverage(
    candidates: HybridCandidate[],
    targetSet: Set<string>,
  ): number {
    if (targetSet.size === 0) {
      return 1.0; // No target → perfect coverage trivially
    }

    const observed = new Set<string>();
    for (const candidate of candidates) {
      for (const value of [
        candidate.producer,
        candidate.region,
        candidate.appellation,
        candidate.grapePrimary,
        candidate.vintageYear?.toString(),
      ]) {
        if (typeof value === 'string' && value.trim().length > 0) {
          observed.add(value.trim().toLowerCase());
        }
      }
    }

    if (observed.size === 0) {
      return 0;
    }

    let covered = 0;
    for (const target of targetSet) {
      if (observed.has(target.trim().toLowerCase())) {
        covered++;
      }
    }

    // targetSet.size > 0 is guaranteed by the empty-check above; Math.max
    // duplicates the guard so semgrep wine-divide-without-zero-guard is
    // satisfied at the division site.
    return clamp01(covered / Math.max(1, targetSet.size));
  }

  /**
   * Epic 10: Computes anchor preservation signal for similar_items mode.
   *
   * Measures how well a candidate preserves core anchor characteristics
   * (body, tannin, region, grapes) while offering novelty.
   *
   * Used in similar_items mode to keep results anchored to the original wine
   * while still providing diverse alternatives.
   *
   * @param anchor - The reference/anchor wine.
   * @param candidate - The candidate to evaluate.
   * @returns Preservation score in [0, 1]. 1 = perfectly preserves anchor.
   */
  computeAnchorPreservation(
    anchor: HybridCandidate,
    candidate: HybridCandidate,
  ): number {
    let totalWeight = 0;
    let preservedWeight = 0;

    if (anchor.region !== undefined && candidate.region !== undefined) {
      totalWeight += ANCHOR_PRESERVE_REGION_WEIGHT;
      // Case-insensitive: index strings may vary in casing across ingestion sources.
      if (anchor.region.toLowerCase() === candidate.region.toLowerCase()) {
        preservedWeight += ANCHOR_PRESERVE_REGION_WEIGHT;
      }
    }

    if (anchor.grapePrimary !== undefined && candidate.grapePrimary !== undefined) {
      totalWeight += ANCHOR_PRESERVE_GRAPE_WEIGHT;
      if (anchor.grapePrimary.toLowerCase() === candidate.grapePrimary.toLowerCase()) {
        preservedWeight += ANCHOR_PRESERVE_GRAPE_WEIGHT;
      }
    }

    preservedWeight += attributeSimilarity(
      anchor.body,
      candidate.body,
      ANCHOR_PRESERVE_BODY_WEIGHT,
    );
    totalWeight += comparableWeight(
      anchor.body,
      candidate.body,
      ANCHOR_PRESERVE_BODY_WEIGHT,
    );

    preservedWeight += attributeSimilarity(
      anchor.tannin,
      candidate.tannin,
      ANCHOR_PRESERVE_TANNIN_WEIGHT,
    );
    totalWeight += comparableWeight(
      anchor.tannin,
      candidate.tannin,
      ANCHOR_PRESERVE_TANNIN_WEIGHT,
    );

    preservedWeight += attributeSimilarity(
      anchor.acidity,
      candidate.acidity,
      ANCHOR_PRESERVE_ACIDITY_WEIGHT,
    );
    totalWeight += comparableWeight(
      anchor.acidity,
      candidate.acidity,
      ANCHOR_PRESERVE_ACIDITY_WEIGHT,
    );

    preservedWeight += attributeSimilarity(
      anchor.sweetness,
      candidate.sweetness,
      ANCHOR_PRESERVE_SWEETNESS_WEIGHT,
    );
    totalWeight += comparableWeight(
      anchor.sweetness,
      candidate.sweetness,
      ANCHOR_PRESERVE_SWEETNESS_WEIGHT,
    );

    if (totalWeight === 0) {
      // fusionRrfTotal absent (browse/compare) → 0 → below floor → low fallback.
      const anchorRaw = candidate.fusionRrfTotal ?? 0;
      return clamp01(
        anchorRaw > ANCHOR_PRESERVE_RETRIEVAL_SIGNAL_FLOOR
          ? ANCHOR_PRESERVE_FALLBACK_HIGH
          : ANCHOR_PRESERVE_FALLBACK_LOW,
      );
    }

    const metadataScore = preservedWeight / totalWeight;
    const anchorRaw2 = candidate.fusionRrfTotal ?? 0;
    const retrievalBoost =
      anchorRaw2 > ANCHOR_PRESERVE_RETRIEVAL_SIGNAL_FLOOR
        ? ANCHOR_PRESERVE_RETRIEVAL_BOOST
        : 0;
    return clamp01(metadataScore + retrievalBoost);
  }
}

// clamp01: imported from @shared/utils/clamp (SSoT). Non-finite input
// emits a process warning via the central helper.

function comparableWeight(
  left: number | undefined,
  right: number | undefined,
  weight: number,
): number {
  return left !== undefined && right !== undefined ? weight : 0;
}

function attributeSimilarity(
  left: number | undefined,
  right: number | undefined,
  weight: number,
): number {
  if (left === undefined || right === undefined) {
    return 0;
  }

  const normalized =
    1
    - Math.min(Math.abs(left - right), ATTRIBUTE_SIMILARITY_MAX_DELTA)
      / ATTRIBUTE_SIMILARITY_MAX_DELTA;
  return normalized * weight;
}
