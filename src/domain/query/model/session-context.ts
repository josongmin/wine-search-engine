/**
 * E6-U1: Session Signal Scope (lock)
 *
 * Session/reformulation signals promoted to serving policy inputs:
 *   - reformulationType: how current query relates to prior
 *   - priorContextCarried: whether prior constraints are inherited
 *   - ambiguityCarryForward: whether prior ambiguity state is inherited
 *   - sessionEntityIds: entities seen this session (for diversity/dedup)
 *
 * Do NOT redesign the session persistence stack or add new signals without
 * an explicit Epic 6 amendment. SessionContext is a read-only policy input.
 */
import type { EntityId } from '../../shared/types/index.js';
import type { ConstraintBundle } from '../../shared/types/index.js';
import type { DecisionStatus } from '../../shared/types/index.js';

/**
 * Conversational session context carried across consecutive queries.
 *
 * Enables reformulation detection and contextual constraint inheritance.
 */
export interface SessionContext {
  /** Unique identifier for the current user session. */
  readonly sessionId: string;

  /** Entity IDs referenced in prior turns of this session. */
  readonly previousEntities: readonly EntityId[];

  /** Constraints from the previous query, for inheritance / narrowing. */
  readonly previousConstraints?: ConstraintBundle | undefined;

  /** The resolution outcome of the last query in this session. */
  readonly lastDecisionStatus?: DecisionStatus | undefined;

  /** Reference (plan ID) to the last query plan produced in this session. */
  readonly lastQueryPlanRef?: string | undefined;
}
