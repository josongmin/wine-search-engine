import type {
  DecisionStatus,
  DecisionConfidenceSemantics,
  NextAction,
  DecisionSnapshot,
} from '../../shared/types/index.js';
import type { FailureReason } from '../../decision/model/failure-reason.js';
import type { AbstainReason } from '../../query/model/abstain-decision.js';
import type {
  ExecutionLaneTrace,
  ExecutionRetrievalMode,
  ExecutionTopology,
} from '../../query/model/engine-execution-contract.js';
import type { QueryRoute } from '../../query/model/query-route.js';

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

  /** The execution route that handled this query. */
  readonly route: QueryRoute;

 /**
   * Decision-layer confidence scalar in [0, 1].
   *
   * Interpret this number according to {@link confidenceSemantics}. Only the
   * calibrated variant may be treated as a probability.
   */
  readonly decisionConfidence: number;

  /** Semantic tag for {@link decisionConfidence}. */
  readonly confidenceSemantics: DecisionConfidenceSemantics;

  /**
   * Whether {@link decisionConfidence} came from trusted calibration params.
   *
   * `false` means the engine resolved via a substitute-trust path over an
   * uncalibrated score. Callers may still use the value for ordering, but
   * MUST NOT treat it as a calibrated probability.
   */
  readonly calibrationTrusted?: boolean | undefined;

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
   * Reason for an abstain-driven outcome (for example `ambiguous` clarify or
   * fail-closed `no_match`).
   *
   * MUST be sourced from TypedAbstainDecision.reason. Never populate this from
   * free-text trace strings such as decisionTrace.finalReason.
   */
  readonly abstainReason?: AbstainReason | undefined;

  /**
   * Indicates whether the retrieval mode was determined by the planner or
   * overridden via the top-level `retrieval_mode` API parameter.
   */
  readonly retrievalModeSource?: 'planner' | 'api_override' | undefined;

  /**
   * The retrieval mode the planner originally suggested, before any
   * API-level override was applied.
   */
  readonly plannerSuggestedMode?: ExecutionRetrievalMode | undefined;

  /** Execution topology compiled for this decision. */
  readonly executionTopology?: ExecutionTopology | undefined;

  /** Lane-level participation and resolve trace for this decision. */
  readonly laneTrace?: ExecutionLaneTrace | undefined;

}
