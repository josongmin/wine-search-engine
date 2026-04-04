import type {
  EntityId,
  DecisionStatus,
  EvidenceItem,
  DecisionSnapshot,
} from '../../shared/types/index.js';

/**
 * The result of evaluating a single case through the search pipeline,
 * per RFC-009 §5.
 *
 * Each result captures the engine's predicted output alongside scoring
 * metadata needed for aggregate metric computation.
 */
export interface EvalResult {
  /** The evaluation case ID this result corresponds to. */
  readonly caseId: string;

  /** The entity ID predicted by the engine, if any. */
  readonly predictedEntityId?: EntityId;

  /** The decision status produced by the engine. */
  readonly predictedStatus: DecisionStatus;

  /** Calibrated decision confidence in [0, 1]. */
  readonly decisionConfidence: number;

  /**
   * Decision Utility score for this case, computed from the utility formula:
   * correct_resolve = +1.0, wrong_resolve = -1.5,
   * safe_abstain = +0.4, avoidable_abstain = -0.3.
   */
  readonly utilityScore: number;

  /** Whether the engine correctly resolved to the expected entity. */
  readonly isCorrectResolve: boolean;

  /** Whether the engine resolved to a WRONG entity (most severe failure). */
  readonly isWrongResolve: boolean;

  /** Whether the engine correctly abstained on a genuinely ambiguous case. */
  readonly isSafeAbstain: boolean;

  /** Whether the engine abstained when a clear answer existed. */
  readonly isAvoidableAbstain: boolean;

  /** Evidence items produced by the engine for this decision. */
  readonly evidenceItems: readonly EvidenceItem[];

  /** End-to-end latency in milliseconds for this case. */
  readonly latencyMs: number;

  /** Snapshot of system versions and config active at decision time. */
  readonly decisionSnapshot: DecisionSnapshot;
}
