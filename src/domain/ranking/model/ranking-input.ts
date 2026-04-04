import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { HybridCandidate } from '../../retrieval/model/hybrid-candidate.js';
import type { AnchorProfile } from '../../retrieval/model/retrieval-input.js';
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
}
