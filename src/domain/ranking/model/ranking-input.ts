import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { CompiledWineQuery } from '../../query/model/compiled-wine-query.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { AnchorProfile } from '../../retrieval/model/retrieval-input.js';
import type { RetrievalChannel } from '../../retrieval/model/retrieval-channel.js';
import type { ConstraintBundle, EntityId } from '../../shared/types/index.js';

/**
 * Optional context about the current user session, used to inform
 * preference-based ranking signals.
 */
export interface UserContext {
  /** Identifier for the current session. */
  readonly sessionId: string;

  /** Entity IDs the user has interacted with previously in this session. */
  readonly previousEntities: readonly EntityId[];

  /** Free-form user preferences extracted from session history. */
  readonly preferences: Readonly<Record<string, unknown>>;
}

/**
 * Input to the ranking pipeline.
 *
 * Ranking is a signal producer/aggregator (RFC-013). It consumes
 * hybrid-retrieval candidates and a query plan, then produces ranked
 * results with component scores. The final binding decision is made
 * by the Decision Layer (RFC-007), not by the ranker.
 */
export interface RankingInput {
  /** The query plan driving this ranking pass. */
  readonly queryPlan: QueryPlanV1;

  /** Candidates produced by the hybrid retrieval pipeline. */
  readonly candidates: readonly HybridCandidate[];

  /** Anchor profile for similarity-based queries (present only for mixed/anchored). */
  readonly anchorProfile?: AnchorProfile | undefined;

  /** Hard, soft, and inferred constraints to enforce during ranking. */
  readonly constraints: ConstraintBundle;

  /** Optional user context for preference-based signals. */
  readonly userContext?: UserContext | undefined;

  /**
   * T5.3: Active retrieval channels for this ranking pass.
   * Used for logging and tracing only — per-candidate channel-aware weight
   * adjustment reads channel information from each candidate's retrievalTrace.
   */
  readonly activeChannels?: readonly RetrievalChannel[] | undefined;

  /**
   * T5.4: When true, forces precision reranking regardless of gate conditions.
   * Intended for testing and operator overrides only.
   */
  readonly rerankForced?: boolean;

  /**
   * E3-U5: Compiled execution contract hint.
   * When present, Ranker uses compiled.execution.effectiveRetrievalMode for
   * getModeWeights() instead of queryPlan.retrievalMode (V1 fallback).
   */
  readonly compiled?: CompiledWineQuery | undefined;
}
