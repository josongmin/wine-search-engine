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
