import type {
  CanonicalEntityId,
  DecisionStatus,
  EvidenceItem,
  DecisionSnapshot,
} from '../../shared/types/index.js';
import type { QueryClass } from '../../shared/types/query-class.js';
import type { QueryIntent } from '../../query/model/query-intent.js';
import type { QueryRoute } from '../../query/model/query-route.js';
import type { LTRScoreComponents } from '../../ranking/service/ltr-feature-extractor.js';
import type { FunnelMetrics } from '../../ranking/model/ranking-stage.js';
import type { EvalProvenanceSlice } from '../../retrieval/model/provenance.js';
import type { ExecutionRetrievalMode } from '../../query/model/engine-execution-contract.js';

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
  readonly predictedEntityId?: CanonicalEntityId;

  /** The decision status produced by the engine. */
  readonly predictedStatus: DecisionStatus;

  /** Calibrated decision confidence in [0, 1]. */
  readonly decisionConfidence: number;

  /**
   * Whether {@link decisionConfidence} is trusted as a calibrated probability.
   *
   * When `false`, the score came from a substitute-trust path over an
   * uncalibrated resolver / ranker signal and must be excluded from ECE.
   */
  readonly decisionConfidenceTrusted?: boolean;

  /**
   * Raw (pre-calibration) top-1 resolver score, if available.
   *
   * Persisted by `PgEvalResultStore` into `eval_results.top1_raw_score`. The
   * nightly calibration trainer (P0.1) consumes (top1RawScore, isCorrectResolve)
   * pairs to fit Platt / isotonic / temperature scaling. Optional because
   * legacy rows pre-dating the column carry NULL.
   */
  readonly top1RawScore?: number;

  /** Surfaced execution contract for honesty-aware offline analysis. */
  readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';

  /** Whether the execution contract was blocking-eligible. */
  readonly blockingEligible?: boolean;

  /** Structured degradation reasons surfaced by the runtime contract. */
  readonly degradationReasons?: readonly string[];

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

  /**
   * Whether this case triggered an RFC-016 admission invariant violation
   * (RFC-009 §4.7).
   *
   * Set by infrastructure adapters when the engine emitted a `resolved`
   * response but the AdmissionGate's invariants were detectably breached
   * (e.g. missing identity_signature, snapshot mismatch, absent required
   * evidence).  Absent or `false` means no violation was detected.
   */
  readonly isAdmissionViolation?: boolean;

  /** Score components from the top result, for LTR training. */
  readonly topResultScoreComponents?: LTRScoreComponents;

  /** T5.6: Ranking funnel metrics captured for this execution when available. */
  readonly funnelMetrics?: FunnelMetrics;

  /**
   * Retrieval provenance slices for this case, forwarded from the eval adapter.
   * Used for channel-level offline analysis and quality regression.
   */
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[];

  /** Runtime planner/execution classification recorded during evaluation. */
  readonly runtimeQueryClass?: QueryClass;
  readonly runtimeIntent?: QueryIntent;
  readonly runtimeRoute?: QueryRoute;
  readonly runtimeRetrievalMode?: ExecutionRetrievalMode;
  readonly goldRuntimeQueryClassMismatch?: boolean;

  /** End-to-end latency in milliseconds for this case. */
  readonly latencyMs: number;

  /** Snapshot of system versions and config active at decision time. */
  readonly decisionSnapshot: DecisionSnapshot;
}
