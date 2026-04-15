import type { CanonicalEntityId, EvidenceItem } from '../../shared/types/index.js';
import type { SourceRecordRef } from '../../entity/model/source-record-ref.js';
import type { CandidateProvenance } from '../../retrieval/model/candidate-envelope.js';
import type { ScoreDecomposition } from './score-decomposition.js';

/**
 * E3-U5: Calibrator feature source contract.
 *
 * A future ranked-route calibrator MUST read its input features exclusively from:
 *   1. {@link RankedResult}  — finalScore, rank, componentScores (semantic,
 *      popularity, attributeAlignment, preferenceAlignment, anchorSimilarity)
 *   2. {@link FunnelMetrics} — retentionRate, rerankChangedTopK, stageLatencies
 *   3. QueryPlanV1.queryClass + CompiledWineQuery.execution.effectiveRoute
 *
 * The calibrator MUST NOT read Ranker-internal private state (e.g. ScoredEntry,
 * coarsePruneCount pre-aggregation) or call any Ranker method directly.
 * All calibrator-relevant signals are observable from ranked results + plan alone.
 */

/**
 * Breakdown of individual scoring components for a ranked candidate.
 *
 * Each component corresponds to a signal defined in RFC-000 section 6.
 * The values are numeric scores typically in [0, 1] except where noted.
 *
 * IMPORTANT: These component scores map to {@link EvidenceItem}s but
 * must NEVER claim exact percentage attribution (RFC-000 section 9.3).
 */
export interface ComponentScores {
  /** Data integrity and consistency of the entity record. */
  readonly entityIntegrity: number;

  /**
   * Similarity to the anchor entity. Present only for anchored/mixed queries.
   * Combines attribute distance and embedding similarity.
   */
  readonly anchorSimilarity?: number | undefined;

  /**
   * Semantic relevance from dense retrieval, normalized to [0, 1].
   * Absent when the candidate did not traverse a dense/fusion lane.
   */
  readonly semantic?: number | undefined;

  /**
   * Gate flag: whether all hard constraints are satisfied.
   * If false, the candidate is filtered out (score = -Infinity).
   */
  readonly hardConstraintPass: boolean;

  /** Weighted satisfaction of soft constraints, in [0, 1]. */
  readonly softConstraint: number;

  /**
   * Structured attribute alignment with query plan attributes.
   * Absent when the query had no structured attribute expectations.
   */
  readonly attributeAlignment?: number | undefined;

  /**
   * Alignment with user taste preferences, in [0, 1].
   * Absent when the runtime path has no authoritative preference signal.
   */
  readonly preferenceAlignment?: number | undefined;

  /**
   * Popularity signal derived from engagement data, tie-breaker level.
   * Absent when no authoritative sparse/engagement popularity signal exists.
   */
  readonly popularity?: number | undefined;

  /**
   * Availability signal; penalizes unavailable items.
   * Absent when no availability data plane is wired into the candidate.
   */
  readonly availability?: number | undefined;

  /** Penalty for uncertainty/ambiguity; subtracted from final score. */
  readonly uncertaintyPenalty: number;

  /**
   * Producer prestige from winery_rating [0, 1].
   * Defined for producer_browse / region_browse / compare_candidates modes.
   * Absent (undefined) when mode does not weight prestige.
   */
  readonly producerPrestige?: number | undefined;

  /**
   * Vintage recency signal [0, 1]. Higher = more recent vintage.
   * Used in browse / comparison modes where recency matters.
   * Absent (undefined) when vintageYear is not available.
   */
  readonly recency?: number | undefined;

  /**
   * Critic score signal [0, 1] normalized from Track-C criticProxy.proxyScore.
   * Falls back to Vivino ratingAvg / 5 when criticProxy absent.
   * Absent (undefined) when no critic signal is available for the candidate.
   */
  readonly criticScore?: number | undefined;

  /**
   * Multilingual match signal [0, 1].
   * 1.0 when the candidate has Korean aliases and the query contained Hangul.
   * 0.0 when no Korean text is present or query is purely Latin.
   */
  readonly multilingualScore?: number | undefined;
}

/**
 * A single ranked result produced by the ranking pipeline.
 *
 * The {@link finalScore} is a ranking signal — it is NOT a calibrated
 * decision confidence C. Calibration is the responsibility of the
 * Decision Layer (RFC-007).
 */
export interface RankedResult {
  /** The entity this result refers to. */
  readonly entityId: CanonicalEntityId;

  /** Canonical display label (e.g. "Opus One 2018"). */
  readonly canonicalLabel: string;

  /**
   * Aggregated ranking score. NOT calibrated confidence C.
   * Used only for ordering candidates within a single query.
   */
  readonly finalScore: number;

  /** 1-based rank position in the result list. */
  readonly rank: number;

  /** Breakdown of individual scoring components. */
  readonly componentScores: ComponentScores;

  /** Evidence trail explaining why this candidate received its score. */
  readonly evidenceItems: readonly EvidenceItem[];

  /** Constraint attribute names satisfied by this ranked result. */
  readonly matchedConstraints: readonly string[];

  /** Constraint attribute names not satisfied by this ranked result. */
  readonly unmetConstraints: readonly string[];

  /** Constraint attribute names that originated from inferred query constraints. */
  readonly inferredConstraints: readonly string[];

  // ─────────────────────────────────────────────────────────────────
  // Epic 15: Wine attributes for drinking window prediction
  // (Populated from Vespa documents during ranking pipeline)
  // ─────────────────────────────────────────────────────────────────

  /** Vintage year (e.g. 2018). */
  readonly vintageYear?: number | undefined;

  /** Wine body intensity ([0,1] normalized float). */
  readonly body?: number | undefined;

  /** Tannin structure ([0,1] normalized float). */
  readonly tannin?: number | undefined;

  /** Acidity level ([0,1] normalized float). */
  readonly acidity?: number | undefined;

  /** Sweetness ([0,1] normalized float). */
  readonly sweetness?: number | undefined;

  /** Critic proxy score (80–100 or 0 if absent). */
  readonly avgCriticProxyScore?: number | undefined;

  /** Canonical critic score normalized to [0, 1]. */
  readonly criticScoreNormalized?: number | undefined;

  /** Label-encoded primary grape variety (0–N, OOV→999). */
  readonly grapePrimaryEnc?: number | undefined;

  /** Label-encoded region/appellation. */
  readonly regionEnc?: number | undefined;

  /** Label-encoded country. */
  readonly countryEnc?: number | undefined;

  /** First year the wine enters its optimal drinking window (Epic 15). Optional. */
  readonly drinkingWindowStart?: number | undefined;

  /** Last year the wine is in its optimal drinking window (Epic 15). Optional. */
  readonly drinkingWindowEnd?: number | undefined;

  /** Model version for cached drinking-window data, when known. */
  readonly drinkingWindowModelVersion?: string | undefined;

  /** Display metadata for responses & offline eval (browse diversity, prestige@k). */
  readonly producer?: string | undefined;
  readonly region?: string | undefined;
  readonly grapePrimary?: string | undefined;
  readonly appellation?: string | undefined;
  readonly producerPrestige?: number | undefined;
  readonly retrievalProvenance?: CandidateProvenance | undefined;

  /** Style descriptor (e.g. "bold", "elegant"). */
  readonly style?: string | undefined;

  /** Classification tier or legal designation. */
  readonly classification?: string | undefined;

  /** Alcohol percentage. */
  readonly alcoholPct?: number | undefined;

  /** Certifications (e.g. "organic", "biodynamic"). */
  readonly certifications?: readonly string[] | undefined;

  /** Food pairing tags. */
  readonly pairingTags?: readonly string[] | undefined;

  /** Occasion suggestions. */
  readonly occasion?: readonly string[] | undefined;

  /** Human-readable price band (e.g. "$20-$30", "premium"). */
  readonly priceBand?: string | undefined;

  /** Price in USD (approximate, from Vivino or other data source). */
  readonly priceUsd?: number | undefined;

  /** ADR-007 upstream source lineage (HTTP `EntitySummary.sourceRecordRefs`). */
  readonly sourceRecordRefs?: readonly SourceRecordRef[] | undefined;

  /**
   * Set to `true` when the policy stage demoted this result from a higher rank
   * (e.g. producer diversity rule). Consumers should use `rank` as the
   * authoritative position; `finalScore` may be higher than results ranked
   * above this one when `policyDemoted` is true.
   */
  readonly policyDemoted?: boolean | undefined;

  /**
   * T5.2: Coarse prune metadata — present only for retained candidates.
   * Pruned candidates never appear in results, so this is always defined
   * on every result returned by the ranking pipeline.
   */
  readonly coarsePruneMeta?: CoarsePruneMeta | undefined;

  /**
   * E5-T1: Score decomposition — rerank-aware normalized score breakdown.
   *
   * Present when the ranker computed a full score decomposition for this result.
   * Absent for legacy ranking paths or when decomposition was skipped (e.g. no LTR).
   *
   * Consumers MUST treat this as optional — the core ranking contract is
   * `finalScore` + `componentScores`. `scoreDecomposition` is additive observability.
   */
  readonly scoreDecomposition?: ScoreDecomposition | undefined;

  /**
   * E5-T3: BM25 sparse rank from retrieval — propagated from ScoredEntry for
   * rerank-safety protected-candidate evaluation (Rule 3: sparseRank === 1 protected).
   *
   * Present only for candidates retrieved via the sparse_bm25 channel.
   * Absent (undefined) for dense-only or anchor-lookup candidates.
   */
  readonly sparseRank?: number | undefined;

}

/**
 * T5.2: Coarse prune stage metadata attached to retained candidates.
 */
export interface CoarsePruneMeta {
  readonly preGateScore: number;
  readonly hardConstraintPassed: boolean;
  readonly entityIntegrityPassed: boolean;
}

/**
 * T5.2: Summary of the coarse prune stage for one query execution.
 */
export interface CoarsePruneStageSummary {
  readonly inputCount: number;
  readonly retainedCount: number;
  readonly prunedCount: number;
  readonly hardConstraintFailCount: number;
  readonly entityIntegrityFailCount: number;
}
