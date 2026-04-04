import type { DecisionStatus, EntityId, NextAction } from '../../shared/types/index.js';
import type { AmbiguityType } from './ambiguity-state.js';
import type { ResolvedCandidate } from './resolved-candidate.js';
import type { ResolverDecisionTrace } from './decision-trace.js';

/**
 * The complete output of the entity resolver pipeline, per RFC-006.
 *
 * The `status` field is the resolver's SUGGESTION — it is NOT the final
 * decision. The {@link DecisionEngine} in the decision domain is the sole
 * authority that produces the binding decision status.
 */
export interface EntityResolveResult {
  /**
   * The resolver's suggested status. This is advisory only; the decision
   * layer may override it based on evidence obligations and policy overlays.
   */
  readonly status: DecisionStatus;

  /** The resolver's recommended next action for the pipeline. */
  readonly recommendedNextAction?: NextAction;

  /** Convenience mirror of the calibrated decision confidence C. */
  readonly decisionConfidenceC?: number;

  /** The top-ranked entity, if one was identified. */
  readonly topEntity?: {
    readonly entityId: EntityId;
    readonly canonicalLabel: string;
    readonly calibratedScore: number;
  };

  /** All scored and ranked candidates, ordered by rank ascending. */
  readonly candidates: readonly ResolvedCandidate[];

  /** Ambiguity information, present when ambiguity was detected. */
  readonly ambiguity?: {
    readonly types: readonly AmbiguityType[];
    readonly severity: 'low' | 'medium' | 'high';
    readonly explanationCodes: readonly string[];
  };

  /** Full diagnostic trace of how the resolver reached its conclusion. */
  readonly decisionTrace: ResolverDecisionTrace;
}
