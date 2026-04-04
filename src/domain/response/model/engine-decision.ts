import type { DecisionStatus, NextAction, DecisionSnapshot } from '../../shared/types/index.js';

/**
 * The external-facing decision record included in every {@link SearchResponseV1}.
 *
 * This is a projection of the internal {@link DecisionOutput} tailored for API
 * consumers. It carries the calibrated decision confidence, the routing label,
 * and a reproducibility snapshot but omits internal signal details.
 */
export interface EngineDecision {
  /** Resolution outcome (resolved / ambiguous / failed). */
  readonly decisionStatus: DecisionStatus;

  /** Prescribed next action for the caller. */
  readonly nextAction: NextAction;

  /** The execution route that handled this query (e.g. "hybrid", "exact"). */
  readonly route: string;

  /**
   * Calibrated decision confidence in [0, 1].
   * This is the ONLY confidence value surfaced to external consumers.
   */
  readonly decisionConfidence: number;

  /** Semantic tag — always `'calibrated_decision_confidence'`. */
  readonly confidenceSemantics: 'calibrated_decision_confidence';

  /** Unique trace reference for pipeline debugging. */
  readonly decisionTraceRef: string;

  /** Snapshot of system versions active at decision time. */
  readonly decisionSnapshot: DecisionSnapshot;
}
