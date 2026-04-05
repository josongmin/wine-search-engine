import type { DecisionStatus, NextAction, DecisionSnapshot } from '../../shared/types/index.js';
import type { FailureReason } from '../../decision/model/failure-reason.js';

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

  /**
   * Machine-readable failure reason when admission was denied (RFC-016 §6, §8).
   * Present only when `decisionStatus` is `failed` or `ambiguous` due to
   * an admission-gate rejection.
   */
  readonly failure_reason?: FailureReason | undefined;

  /**
   * Trace reference emitted by the AdmissionGate on rejection (RFC-016 §8).
   * Correlates this decision with pipeline logs for auditability.
   */
  readonly admission_trace_ref?: string | undefined;

  /**
   * Reason for abstention when decisionStatus is 'ambiguous' but not due to
   * hard constraint violation (Epic 9). Omitted if decision was not ambiguous
   * or if ambiguity was hard-constraint-related.
   */
  readonly abstainReason?: string | undefined;
}
