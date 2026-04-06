import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { EntityId } from '../../shared/types/index.js';

/**
 * Profile of the anchor entity used for similarity-based retrieval.
 * Built from the anchor candidate resolved earlier in the pipeline.
 */
export interface AnchorProfile {
  /** Semantic summary text to be embedded for nearest-neighbor search. */
  readonly semanticSummary: string;

  /** Pre-computed embedding vector for the anchor (optional; will be computed if absent). */
  readonly embedding?: readonly number[] | undefined;

  /** Confidence that the anchor was correctly resolved, in [0, 1]. */
  readonly anchorConfidence: number;
}

/**
 * Input contract for the hybrid retrieval pipeline (RFC-012).
 *
 * Produced by the query planner and consumed by {@link CandidatePoolService}.
 */
export interface HybridRetrievalInput {
  /** The full query plan driving this retrieval. */
  readonly queryPlan: QueryPlanV1;

  /** Execution route — determines retrieval profile selection. */
  readonly route: 'hybrid' | 'mixed';

  /** Lexical query strings for sparse (BM25) retrieval. */
  readonly lexicalQueries: readonly string[];

  /** Semantic query strings to be embedded for dense retrieval. */
  readonly semanticQueries: readonly string[];

  /** Hard constraints that MUST be satisfied (used as filters). */
  readonly hardConstraints: readonly NormalizedConstraint[];

  /** Soft constraints that SHOULD be satisfied (used for scoring, not filtering). */
  readonly softConstraints: readonly NormalizedConstraint[];

  /** Optional anchor profile for similarity-based ("wines like X") queries. */
  readonly anchorProfile?: AnchorProfile | undefined;

  /**
   * Optional resolved anchor entity for channel-aware retrieval passes.
   * CandidatePool may use this to build an anchor profile or apply
   * relative filtering without inventing a new public retrieval mode.
   */
  readonly anchorEntityId?: EntityId | undefined;
}
