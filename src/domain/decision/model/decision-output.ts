import type {
  CanonicalEntityId,
  DecisionStatus,
  DecisionConfidenceSemantics,
  NextAction,
  EvidenceItem,
  DecisionSnapshot,
  SignalSet,
} from '../../shared/types/index.js';
import type { ResolvedCandidate } from '../../resolver/model/resolved-candidate.js';
import type { DecisionTrace } from './decision-trace.js';
import type { FailureReason } from './failure-reason.js';

/**
 * The binding output of the Decision domain — the FINAL AUTHORITY on
 * every resolution decision in the Wine Intelligence Engine, per RFC-007.
 *
 * No downstream component may override `decisionStatus` or `nextAction`.
 * This is the internal decision representation; the Response domain maps
 * it to the external-facing API surface.
 */
export interface DecisionOutput {
  /** Resolution outcome. */
  readonly decisionStatus: DecisionStatus;

  /** Prescribed next action for the pipeline. */
  readonly nextAction: NextAction;

  /**
   * Decision-layer confidence scalar in [0, 1].
   *
   * Interpret this number according to {@link confidenceSemantics}. Only the
   * calibrated variant may be treated as a probability.
   */
  readonly decisionConfidence: number;

  /** Semantic label for {@link decisionConfidence}. */
  readonly confidenceSemantics: DecisionConfidenceSemantics;

  /**
   * Whether {@link decisionConfidence} was produced from trusted calibration
   * parameters rather than a substitute-trust path over an uncalibrated score.
   *
   * When `false`, the numeric value is still monotonic for ranking/ordering,
   * but it MUST NOT be treated as a calibrated probability in ECE/reliability
   * analysis.
   */
  readonly calibrationTrusted?: boolean;

  /** The selected entity, present only when status is 'resolved'. */
  readonly selectedEntity?: {
    readonly entityId: CanonicalEntityId;
    readonly canonicalLabel?: string;
    /**
     * Cryptographic identity seal (RFC-016 §3 EntityRef).
     * Hash of entity ID + active snapshot fields — prevents reconstruction
     * from projection fields alone.
     */
    readonly identity_signature: string;
    /**
     * Stable reference to the snapshot under which this entity was resolved.
     * Used for audit trails and replay correlation.
     */
    readonly snapshot_ref: string;
  };

  /** Primary entity chosen by the decision layer (absent when status is `failed`). */
  readonly chosenEntityId?: CanonicalEntityId | undefined;

  /** Candidate list for downstream consumption (e.g. clarification UI). */
  readonly candidates?: readonly ResolvedCandidate[];

  /** Full signal set that was evaluated to produce this decision. */
  readonly signalSet: SignalSet;

  /** Evidence items explaining why this decision was reached. */
  readonly evidenceItems: readonly EvidenceItem[];

  /** A unique reference for tracing this decision through the pipeline. */
  readonly decisionTraceRef: string;

  /** Snapshot of system versions active at decision time. */
  readonly decisionSnapshot: DecisionSnapshot;

  /** Full diagnostic trace of how the decision was reached (RFC-007). */
  readonly decisionTrace: DecisionTrace;

  /**
   * When admission is denied by the {@link AdmissionGate} (RFC-016), this
   * field carries the machine-readable reason.  Absent on admitted decisions.
   */
  readonly failureReason?: FailureReason;

  /**
   * Trace reference emitted by the {@link AdmissionGate} when admission is
   * denied (RFC-016).  Absent on admitted decisions.
   */
  readonly admissionTraceRef?: string;
}
