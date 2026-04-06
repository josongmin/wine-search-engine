import type { EntityId, EvidenceItem } from '../../shared/types/index.js';

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

  /** Semantic relevance from dense retrieval, normalized to [0, 1]. */
  readonly semantic: number;

  /**
   * Gate flag: whether all hard constraints are satisfied.
   * If false, the candidate is filtered out (score = -Infinity).
   */
  readonly hardConstraintPass: boolean;

  /** Weighted satisfaction of soft constraints, in [0, 1]. */
  readonly softConstraint: number;

  /** Structured attribute alignment with query plan attributes. */
  readonly attributeAlignment: number;

  /** Alignment with user taste preferences, in [0, 1]. */
  readonly preferenceAlignment: number;

  /** Popularity signal derived from engagement data, tie-breaker level. */
  readonly popularity: number;

  /** Availability signal; penalizes unavailable items. */
  readonly availability: number;

  /** Penalty for uncertainty/ambiguity; subtracted from final score. */
  readonly uncertaintyPenalty: number;
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
  readonly entityId: EntityId;

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

  // ─────────────────────────────────────────────────────────────────
  // Epic 15: Wine attributes for drinking window prediction
  // (Populated from Vespa documents during ranking pipeline)
  // ─────────────────────────────────────────────────────────────────

  /** Vintage year (e.g. 2018). */
  readonly vintage?: number | undefined;

  /** Wine body intensity (1–5 ordinal scale). */
  readonly body?: number | undefined;

  /** Tannin structure (1–5 ordinal scale). */
  readonly tannin?: number | undefined;

  /** Acidity level (1–5 ordinal scale). */
  readonly acidity?: number | undefined;

  /** Sweetness (1–5 ordinal scale). */
  readonly sweetness?: number | undefined;

  /** Critic proxy score (80–100 or 0 if absent). */
  readonly avgCriticProxyScore?: number | undefined;

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
}
