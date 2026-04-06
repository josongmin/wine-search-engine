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

  /**
   * Legacy trace string — same value as {@link authorityTraceRef} in Wave 3+.
   * Prefer `authorityTraceRef` for new integrations (OpenAPI migration Phase A–C).
   */
  readonly decisionTraceRef: string;

  /** Deterministic authority identifier for replay, audit, and cache keys. */
  readonly authorityTraceRef?: string | undefined;

  /** Observability-only correlation (may equal HTTP request id). */
  readonly runtimeCorrelationRef?: string | undefined;

  readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';

  readonly blockingEligible?: boolean;

  readonly degradationReasons?: readonly string[] | undefined;

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

  /**
   * Indicates whether the retrieval mode was determined by the planner or
   * overridden via the top-level `retrieval_mode` API parameter.
   */
  readonly retrievalModeSource?: 'planner' | 'api_override' | undefined;

  /**
   * The retrieval mode the planner originally suggested, before any
   * API-level override was applied.
   */
  readonly plannerSuggestedMode?: string | undefined;
}
