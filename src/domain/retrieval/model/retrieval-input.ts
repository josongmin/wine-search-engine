import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { EntityId } from '../../shared/types/index.js';
import type { ExecutionRetrievalMode } from '../../query/model/engine-execution-contract.js';
import type { RetrievalPlan } from '../service/retrieval-plan-builder.js';

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
 *
 * E2-U3: compiled hint fields allow retrieval to use ExecutionCompiler decisions
 * without re-deriving route/mode from QueryPlanV1. When present, consumers should
 * prefer compiledRetrievalMode over queryPlan.retrievalMode.
 */
export interface HybridRetrievalInput {
  /** The full query plan driving this retrieval. */
  readonly queryPlan: QueryPlanV1;

  /** Execution route — determines retrieval profile selection. */
  readonly route: 'hybrid' | 'mixed';

  /**
   * E2-U3: Compiled retrieval mode from EngineExecutionContract.
   * When present, this is the authoritative mode for profile selection and
   * specialised path dispatch. Absent for legacy callers using V1-only path.
   */
  readonly compiledRetrievalMode?: ExecutionRetrievalMode | undefined;

  /** Lexical query strings for sparse (BM25) retrieval. */
  readonly lexicalQueries: readonly string[];

  /** Semantic query strings to be embedded for dense retrieval. */
  readonly semanticQueries: readonly string[];

  /** Hard constraints that MUST be satisfied (used as filters). */
  readonly hardConstraints: readonly NormalizedConstraint[];

  /** Soft constraints that SHOULD be satisfied (used for scoring, not filtering). */
  readonly softConstraints: readonly NormalizedConstraint[];

  /** Structured retrieval plan (filter + boost + inferred priors) derived from the query. */
  readonly retrievalPlan?: RetrievalPlan | undefined;

  /** Optional anchor profile for similarity-based ("wines like X") queries. */
  readonly anchorProfile?: AnchorProfile | undefined;

  /**
   * Optional resolved anchor entity for channel-aware retrieval passes.
   * CandidatePool may use this to build an anchor profile or apply
   * relative filtering without inventing a new public retrieval mode.
   */
  readonly anchorEntityId?: EntityId | undefined;
}
