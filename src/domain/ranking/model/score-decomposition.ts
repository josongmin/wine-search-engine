/**
 * E5-T1: ScoreDecomposition — rerank-aware normalized score layer.
 *
 * Extends the existing {@link ComponentScores} with:
 *  1. Named contribution breakdowns (lexical, semantic, anchor, attribute,
 *     popularity, preference)
 *  2. Heuristic aggregate (raw + normalized)
 *  3. LTR/rerank delta fields (when precision rerank ran)
 *
 * Design invariants:
 *  - Does NOT replace componentScores. It is an additive layer on RankedResult.
 *  - `heuristicScoreNormalized` is the same [0,1] bounded contract as the
 *    existing ranker output — no new scale, no raw ratio comparisons.
 *  - `rerankDeltaNormalized` = ltrScoreNormalized − heuristicScoreNormalized.
 *    Positive = LTR promoted; negative = LTR demoted.
 *  - All fields are optional-by-default so the type can be populated
 *    incrementally without requiring a full refactor of the ranker pipeline.
 */
export interface ScoreDecomposition {
  // ─── Primary signal contributions ───────────────────────────────────────

  /** BM25 × sparseWeight contribution to heuristic score. */
  readonly lexicalContribution: number;

  /** cosine-similarity × denseWeight contribution. */
  readonly semanticContribution: number;

  /**
   * Anchor-similarity × anchorWeight contribution.
   * 0 for non-anchored queries.
   */
  readonly anchorContribution: number;

  /** Constraint match satisfaction contribution (soft + inferred). */
  readonly attributeSatisfaction: number;

  /** Popularity × popularityWeight contribution. */
  readonly popularityContribution: number;

  /** Preference alignment × weight contribution. */
  readonly preferenceAlignmentContribution: number;

  // ─── Heuristic aggregate ─────────────────────────────────────────────────

  /**
   * Raw sum of weighted contributions before normalization.
   *
   * DIAGNOSTIC ONLY. Query-class scale varies — do NOT compare across
   * query classes or use as a safety threshold. See RFC-E5 §design-premise.
   */
  readonly heuristicScoreRaw: number;

  /**
   * Normalized heuristic aggregate in [0, 1].
   * Same contract as the existing ranker `finalScore` before LTR rerank.
   * This is the authoritative pre-rerank score.
   */
  readonly heuristicScoreNormalized: number;

  // ─── LTR rerank fields (present only when LTR ran) ──────────────────────

  /**
   * Normalized LTR inference score in [0, 1].
   * Absent when LTR rerank was skipped (skipReason ≠ 'not_skipped').
   */
  readonly ltrScoreNormalized?: number | undefined;

  /**
   * ltrScoreNormalized − heuristicScoreNormalized.
   * Positive = LTR promoted this candidate.
   * Negative = LTR demoted.
   * Absent when LTR was skipped.
   */
  readonly rerankDeltaNormalized?: number | undefined;

  /**
   * Raw LTR feature vector (LAMBDAMART_FEATURE_DIMENSION = 8 values).
   * Absent when LTR was skipped or features unavailable.
   */
  readonly ltrFeatureVector?: readonly number[] | undefined;

  // ─── Final ──────────────────────────────────────────────────────────────

  /**
   * The final score after all stages — same as RankedResult.finalScore.
   * Duplicated here so ScoreDecomposition is self-contained for tracing.
   */
  readonly finalScore: number;
}

/**
 * E5-T2: Safety evaluation result for one candidate during rerank.
 *
 * The Safety Envelope runs before LTR is applied. If `allowed === false`,
 * the candidate's heuristic rank is preserved (LTR is not applied to it).
 */
export interface RerankSafetyResult {
  /** Whether this candidate is allowed to be reranked by LTR. */
  readonly allowed: boolean;

  /**
   * Why reranking was blocked. Absent when allowed === true.
   *
   * - `hard_constraint_violation`  — candidate fails a hard constraint and
   *                                   cannot be promoted above compliant candidates.
   * - `rank_invariant_breach`      — LTR would move this candidate above a
   *                                   hard-constraint-satisfying candidate.
   * - `protected_candidate_eviction` — exact-anchor / sparse-rank-1 candidate
   *                                   being pushed down by non-protected candidate.
   */
  readonly blockedReason?:
    | 'hard_constraint_violation'
    | 'rank_invariant_breach'
    | 'protected_candidate_eviction'
    | undefined;

  /** Which hard constraint attribute names were violated. */
  readonly constraintViolations?: readonly string[] | undefined;

  /** Observability metrics attached to this evaluation. */
  readonly metrics?: RerankSafetyMetrics | undefined;
}

/** Observability metrics for a single safety evaluation. */
export interface RerankSafetyMetrics {
  readonly heuristicScoreNormalized?: number | undefined;
  readonly ltrScoreNormalized?: number | undefined;
  readonly preRerankRank?: number | undefined;
  readonly postRerankRank?: number | undefined;
  readonly preRerankTop1Gap?: number | undefined;
  readonly postRerankTop1Gap?: number | undefined;
}

/**
 * E5-T3: Score drift record — per-query LTR vs heuristic ordering drift.
 *
 * Used by ScoreDriftMonitor for deployment-unit observability and as
 * an acceptance gate when LTR models are promoted.
 */
export interface ScoreDriftRecord {
  /** Query class (e.g. 'entity_exact', 'semantic_preference'). */
  readonly queryClass: string;

  /** Top-3 entity IDs ordered by heuristic score. */
  readonly heuristicTop3EntityIds: readonly string[];

  /** Top-3 entity IDs ordered by LTR score. */
  readonly ltrTop3EntityIds: readonly string[];

  /**
   * Kendall tau distance between heuristic and LTR orderings
   * for the top-K candidates that entered the reranker.
   * 0 = identical order, 1 = completely reversed.
   */
  readonly rankOrderChanges: number;

  /** Mean absolute rerankDeltaNormalized across reranked candidates. */
  readonly averageRerankDeltaNormalized: number;

  /** Number of candidates blocked by the safety envelope in this request. */
  readonly safetyEnvelopeBlocks: number;
}
