import type { EntityId } from '../../shared/types/index.js';
import type { RetrievalTrace } from './retrieval-trace.js';

/**
 * A single candidate produced by the hybrid retrieval pipeline.
 *
 * The {@link retrievalFusionScore} is a retrieval-stage ranking signal
 * derived from Reciprocal Rank Fusion (RRF). It is **never** a calibrated
 * decision confidence — that value is computed downstream by the Decision domain.
 */
export interface HybridCandidate {
  /** Entity identifier for this candidate. */
  readonly entityId: EntityId;

  /** Canonical display label (e.g. "Opus One 2018"). Propagated from RetrievalDocument. */
  readonly canonicalLabel?: string | undefined;

  /** Producer name from index summary (rerank / evidence). */
  readonly producer?: string | undefined;

  /** Region from index summary (rerank / evidence). */
  readonly region?: string | undefined;

  /** English search text snippet from index (cross-encoder passage). */
  readonly searchTextEn?: string | undefined;

  /** Primary grape from index summary (cross-encoder passage). */
  readonly grapePrimary?: string | undefined;

  /** Style descriptor propagated from retrieval summaries. */
  readonly style?: string | undefined;

  /** Price band propagated from retrieval summaries. */
  readonly priceBand?: string | undefined;

  /** Pairing suggestions propagated from retrieval summaries. */
  readonly pairing?: readonly string[] | undefined;

  /** Occasion suggestions propagated from retrieval summaries. */
  readonly occasion?: readonly string[] | undefined;

  /** First year the wine enters its optimal drinking window (Epic 15). Optional. */
  readonly drinkingWindowStart?: number | undefined;

  /** Last year the wine is in its optimal drinking window (Epic 15). Optional. */
  readonly drinkingWindowEnd?: number | undefined;

  /** Model version for cached drinking-window data, when propagated from the index. */
  readonly drinkingWindowModelVersion?: string | undefined;

  // ─────────────────────────────────────────────────────────────────
  // Epic 15: Wine attributes for dynamic drinking window prediction
  // (Propagated from RetrievalDocument via Ranker)
  // ─────────────────────────────────────────────────────────────────

  /** Vintage year (e.g. 2018). */
  readonly vintageYear?: number | undefined;

  /** Wine body intensity (1–5 ordinal scale). */
  readonly body?: number | undefined;

  /** Tannin structure (1–5 ordinal scale). */
  readonly tannin?: number | undefined;

  /** Acidity level (1–5 ordinal scale). */
  readonly acidity?: number | undefined;

  /** Sweetness (1–5 ordinal scale). */
  readonly sweetness?: number | undefined;

  /** Finish length in [0, 1] or normalized ordinal scale. */
  readonly finishLength?: number | undefined;

  /** Catalog wine type (e.g. red, white, sparkling). */
  readonly wineType?: string | undefined;

  /** Critic score normalized from 0-100 to raw value (80–100 or 0 if absent). */
  readonly criticScoreNormalized?: number | undefined;

  /** Producer prestige from the search index (browse / rerank signal). */
  readonly producerPrestige?: number | undefined;

  /** Country of origin (e.g. "France"). */
  readonly country?: string | undefined;

  /** Appellation/region (e.g. "Napa Valley"). */
  readonly appellation?: string | undefined;

  /** Classification tier or legal designation. */
  readonly classification?: string | undefined;

  /** Alcohol percentage. */
  readonly alcoholPct?: number | undefined;

  /** Actual price in USD. */
  readonly priceUsd?: number | undefined;

  /** Certifications carried by the candidate wine. */
  readonly certifications?: readonly string[] | undefined;

  /** Vineyard soil type. */
  readonly soilType?: string | undefined;

  /** Producer archetype. */
  readonly producerType?: string | undefined;

  /** Rank from the sparse (BM25) retrieval pass, if present. */
  readonly sparseRank?: number | undefined;

  /** Rank from the dense (embedding) retrieval pass, if present. */
  readonly denseRank?: number | undefined;

  /** Rank from the anchor-neighbourhood retrieval pass, if present. */
  readonly anchorRank?: number | undefined;

  /**
   * Fused retrieval score from RRF across all contributing passes.
   * This is a retrieval-stage ranking signal — NOT decision_confidence.
   */
  readonly retrievalFusionScore: number;

  /** Constraint attribute names matched by this candidate. */
  readonly matchedConstraints: readonly string[];

  /** Hard constraint attribute names this candidate fails to satisfy. */
  readonly unmetHardConstraints?: readonly string[] | undefined;

  /** Diagnostic trace for observability and debugging. */
  readonly retrievalTrace: RetrievalTrace;
}
