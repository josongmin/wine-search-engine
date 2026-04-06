import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { AnchorProfile } from '../../retrieval/model/retrieval-input.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
import type { ComponentScores } from '../model/ranked-result.js';

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
      score += matchRatio * 0.1;
    }

    // Penalize if there are anchors but no anchor rank (suggests non-anchor match)
    if (queryPlan.anchors.length > 0 && candidate.anchorRank === undefined) {
      score -= 0.1;
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
    if (anchorRank === undefined) {
      return 0;
    }

    // Rank-based similarity: 1/(1 + log(rank))
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
    const matchedSet = new Set(candidate.matchedConstraints);
    return constraints.hard.every(
      (c: NormalizedConstraint) => matchedSet.has(c.attribute),
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
  ): number {
    const softConstraints = constraints.soft;
    if (softConstraints.length === 0) {
      return 1.0; // No soft constraints → perfect score
    }

    const matchedSet = new Set(candidate.matchedConstraints);
    let weightedSum = 0;
    let totalWeight = 0;

    for (const constraint of softConstraints) {
      const weight = constraint.confidence;
      totalWeight += weight;
      if (matchedSet.has(constraint.attribute)) {
        weightedSum += weight;
      }
    }

    // Also consider inferred constraints at reduced weight
    for (const constraint of constraints.inferred) {
      const weight = constraint.confidence * 0.5; // Inferred = half weight
      totalWeight += weight;
      if (matchedSet.has(constraint.attribute)) {
        weightedSum += weight;
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
    const raw = candidate.retrievalFusionScore;

    // Sigmoid normalization: 1 / (1 + exp(-k * (x - midpoint)))
    // Tuned so that typical RRF scores map to [0.2, 0.8]
    const k = 10;
    const midpoint = 0.05; // Typical RRF midpoint
    const normalized = 1 / (1 + Math.exp(-k * (raw - midpoint)));

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
      return 0.5;
    }

    const matchedSet = new Set(candidate.matchedConstraints);
    let matchCount = 0;
    for (const attr of expectedAttributes) {
      if (matchedSet.has(attr)) {
        matchCount++;
      }
    }

    return clamp01(matchCount / expectedAttributes.size);
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
      return 0.3; // No BM25 data → neutral baseline
    }

    // log-decay: 1 / (1 + log(rank))
    return clamp01(1 / (1 + Math.log(sparseRank)));
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
      candidateUncertainty = unmatchedRatio * 0.5;
    }

    // Combine query-level and candidate-level uncertainty
    return clamp01(queryUncertainty * 0.6 + candidateUncertainty * 0.4);
  }

  /**
   * Computes producer prestige signal from the candidate's indexed prestige score.
   *
   * Producer prestige is stored in Vespa as [0, 1] (winery_rating / 5).
   * When absent we return a neutral mid-point (0.5) rather than 0 so that
   * wines without prestige data are not systematically suppressed.
   *
   * @param candidate - The hybrid candidate to evaluate.
   * @returns Producer prestige in [0, 1].
   */
  computeProducerPrestige(candidate: HybridCandidate): number {
    if (candidate.producerPrestige !== undefined) {
      return clamp01(candidate.producerPrestige);
    }
    // Neutral when prestige data is absent — don't penalise missing data.
    return 0.5;
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
    const HALF_LIFE_YEARS = 8;
    const decay = Math.LN2 / HALF_LIFE_YEARS;
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
    referenceYear: number = new Date().getFullYear(),
    queryContainsHangul = false,
  ): ComponentScores {
    const recency = this.computeRecency(candidate, referenceYear);
    const criticScore = this.computeCriticScore(candidate);
    return {
      entityIntegrity: this.computeEntityIntegrity(candidate, queryPlan),
      anchorSimilarity: anchorProfile !== undefined
        ? this.computeAnchorSimilarity(candidate, anchorProfile)
        : undefined,
      semantic: this.computeSemanticScore(candidate),
      hardConstraintPass: this.evaluateHardConstraints(candidate, constraints),
      softConstraint: this.computeSoftConstraint(candidate, constraints),
      attributeAlignment: this.computeAttributeAlignment(candidate, queryPlan),
      preferenceAlignment: 0.5, // Neutral default — requires user context enrichment
      popularity: this.computePopularity(candidate),
      availability: this.computeAvailability(candidate),
      uncertaintyPenalty: this.computeUncertaintyPenalty(candidate, queryPlan),
      producerPrestige: this.computeProducerPrestige(candidate),
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

    // Return penalty as ratio of duplicates to total candidates
    return clamp01(duplicateCount / candidates.length);
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

    return clamp01(covered / targetSet.size);
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
      totalWeight += 0.25;
      if (anchor.region === candidate.region) {
        preservedWeight += 0.25;
      }
    }

    if (anchor.grapePrimary !== undefined && candidate.grapePrimary !== undefined) {
      totalWeight += 0.20;
      if (anchor.grapePrimary === candidate.grapePrimary) {
        preservedWeight += 0.20;
      }
    }

    preservedWeight += attributeSimilarity(anchor.body, candidate.body, 0.15);
    totalWeight += comparableWeight(anchor.body, candidate.body, 0.15);

    preservedWeight += attributeSimilarity(anchor.tannin, candidate.tannin, 0.15);
    totalWeight += comparableWeight(anchor.tannin, candidate.tannin, 0.15);

    preservedWeight += attributeSimilarity(anchor.acidity, candidate.acidity, 0.10);
    totalWeight += comparableWeight(anchor.acidity, candidate.acidity, 0.10);

    preservedWeight += attributeSimilarity(anchor.sweetness, candidate.sweetness, 0.05);
    totalWeight += comparableWeight(anchor.sweetness, candidate.sweetness, 0.05);

    if (totalWeight === 0) {
      return clamp01(candidate.retrievalFusionScore > 0.05 ? 0.6 : 0.4);
    }

    const metadataScore = preservedWeight / totalWeight;
    const retrievalBoost = candidate.retrievalFusionScore > 0.05 ? 0.05 : 0;
    return clamp01(metadataScore + retrievalBoost);
  }
}

/**
 * Clamps a numeric value to the [0, 1] range.
 */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

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

  const maxDelta = 4;
  const normalized = 1 - Math.min(Math.abs(left - right), maxDelta) / maxDelta;
  return normalized * weight;
}
