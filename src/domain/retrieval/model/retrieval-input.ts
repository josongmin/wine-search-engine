import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { CanonicalEntityId } from '../../shared/types/index.js';
import type { ConstraintGraph } from '../../query/model/constraint-graph.js';
import type { ExecutionRetrievalMode } from '../../query/model/engine-execution-contract.js';
import type { RetrievalPlan } from '../service/retrieval-plan-builder.js';
import type { RequestExecutionContext } from '../../shared/request-execution-context.js';

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
 * E2-U3: retrieval runtime meaning comes from compiled execution.
 * Consumers must use compiledRetrievalMode as the authoritative mode and must
 * not re-derive runtime mode from QueryPlanV1.
 */
export interface HybridRetrievalInput {
  /** The full query plan driving this retrieval. */
  readonly queryPlan: QueryPlanV1;

  /** Execution route — determines retrieval profile selection. */
  readonly route: 'hybrid' | 'mixed';

  /**
   * E2-U3: Compiled retrieval mode from EngineExecutionContract.
   * This is the authoritative mode for profile selection and specialised
   * path dispatch. Production callers must provide it.
   */
  readonly compiledRetrievalMode?: ExecutionRetrievalMode | undefined;

  /**
   * Absolute compiled execution ceiling for retrieval candidates.
   *
   * Retrieval exploration and assembly must not exceed this bound even when
   * profile-level fanout settings are larger.
   */
  readonly executionBudgetMaxCandidates?: number | undefined;

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
  readonly anchorEntityId?: CanonicalEntityId | undefined;

  /**
   * Optional request-scoped execution context. When present, retrieval
   * code may consult `requestContext.stageTimer` to record per-stage
   * latency, or `requestContext.abortSignal` to abort in-flight work.
   * Optional so non-HTTP callers (background jobs, unit tests) can omit it.
   */
  readonly requestContext?: RequestExecutionContext | undefined;

  /**
   * ADR-014 Phase 1b.3b: optional constraint graph projected from the
   * compiled query. When present, the retrieval annotator emits
   * `matchedAtomRefs` / `unmetAtomRefs` on each candidate so the ranker
   * can distinguish "matched via slot A vs slot B" under XOR.
   * Absent → flat annotator path, byte-identical to pre-PR5.
   */
  readonly constraintGraph?: ConstraintGraph | undefined;

  /**
   * TA4: Entity hypothesis sources from fuzzy planner hits.
   *
   * When the planner's fuzzy matcher fires (anchor-miss case), the matched
   * terms are surfaced here as entity hypothesis candidates. Retrieval layers
   * that support entity-first dual retrieval use these to seed the entity path
   * before falling back to the discovery path.
   *
   * Absent when anchor extraction succeeded (no fuzzy fallback needed).
   */
  readonly entityHypothesisTerms?: readonly string[] | undefined;
}
