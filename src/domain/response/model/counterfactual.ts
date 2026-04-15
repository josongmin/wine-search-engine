import type { EvalProvenanceSlice } from '../../retrieval/model/provenance.js';
import type { CanonicalEntityId, DecisionSnapshot } from '../../shared/types/index.js';
import type { AuditExtension } from '../../audit/model/audit-extension.js';
import type { AdmissionClosureSummary } from '../../decision/model/decision-input.js';
import type {
  ExecutionBudget,
  MissingProvenanceObligation,
  ExecutionProvenanceClosure,
  ExecutionRetrievalMode,
  ProvenancePolicy,
} from '../../query/model/engine-execution-contract.js';
import type { QueryRoute } from '../../query/model/query-route.js';
import type { DecisionStatus, NextAction } from '../../shared/types/index.js';
import type { FailureReason } from '../../decision/model/failure-reason.js';
import type {
  SpecializedFallbackReason,
  SpecializedRouteName,
} from './specialized-route.js';

/**
 * Structured rejection categories for counterfactuals. Lets downstream
 * consumers branch on type instead of substring-matching `rejectedReason`.
 *
 * - `lower_calibrated_score`: resolver alternate beaten by top entity in
 *   calibrated scoring (the classic "rejected vs. winner" case).
 * - `below_top_window`: ranked-tail item that fell outside the top-K window.
 * - `abstain_tied`: engine abstained — there is NO winner; this entity is one
 *   of the indistinguishable candidates the engine held on. Distinct from
 *   rejection because nothing was actually rejected.
 */
export type CounterfactualRejectionType =
  | 'lower_calibrated_score'
  | 'below_top_window'
  | 'abstain_tied';

/**
 * A candidate that was considered but ultimately rejected, with the reason.
 * Included in the response for transparency and debugging.
 */
export interface CounterfactualReject {
  /** Entity that was rejected. */
  readonly entityId: CanonicalEntityId;

  /** Display label for the rejected entity (when available). */
  readonly canonicalLabel?: string | undefined;

  /**
   * Structured rejection category. Required field — producers always know
   * the category at emission time.
   */
  readonly rejectionType: CounterfactualRejectionType;

  /** Human-readable reason this entity was not included in results. */
  readonly rejectedReason: string;

  /** Optional reference to the evidence item that led to rejection. */
  readonly evidenceRef?: string | undefined;
}

export interface ExecutionContractMeta {
  readonly effectiveRetrievalMode: ExecutionRetrievalMode;
  readonly retrievalModeSource: 'planner' | 'api_override';
  readonly plannerSuggestedMode: ExecutionRetrievalMode;
  readonly retrievalKind:
    | 'entity_lookup'
    | 'generic_hybrid'
    | 'specialized_hybrid'
    | 'mixed_similarity';
  readonly sparseExecuted: boolean;
  readonly specializedRouteExecuted?: SpecializedRouteName | null | undefined;
  readonly usedCompiledExecution: boolean;
  readonly budget?: ExecutionBudget | undefined;
  readonly provenancePolicy?: ProvenancePolicy | undefined;
  readonly provenanceClosure?: ExecutionProvenanceClosure | undefined;
  readonly admissionClosure?: AdmissionClosureSummary | undefined;
}

/**
 * Stable provenance closure surfaced on the public response contract.
 *
 * This is the canonical public projection of the compiled execution contract
 * plus the final decision-layer gate outcome. `auditExtension.execution_trace`
 * remains debug-only; clients should rely on this block instead.
 */
export interface ProvenanceTraceMeta {
  readonly policy: ProvenancePolicy;
  readonly observed: {
    readonly topEntityPresent: boolean;
    readonly preRank: ExecutionProvenanceClosure['preRank'];
    readonly postRank: ExecutionProvenanceClosure['postRank'];
  };
  readonly missing: readonly MissingProvenanceObligation[];
  readonly shortfalls: readonly string[];
  readonly gateDecisions: {
    readonly admission:
      | 'admission_gate_passed'
      | 'admission_gate_rejected'
      | 'admission_gate_not_applicable';
    readonly decision:
      | 'decision_gate_resolved'
      | 'decision_gate_ambiguous'
      | 'decision_gate_failed';
    readonly decisionStatus: DecisionStatus;
    readonly nextAction: NextAction;
    readonly failureReason?: FailureReason | undefined;
  };
  readonly admissionClosure?: AdmissionClosureSummary | undefined;
}

/**
 * Top-level metadata attached to every {@link SearchResponseV1}.
 */
export interface ResponseMeta {
  /** Caller-supplied request identifier for correlation. */
  readonly requestId?: string | undefined;

  /** Wall-clock time (ms) from query receipt to response assembly. */
  readonly queryTimeMs: number;

  /** Execution route label. */
  readonly route: QueryRoute;

  /** Semantic version of the response format. */
  readonly version: string;

  /**
   * Schema identifier for the response envelope — RFC-014 §4.2 contract.
   * Always `"search_response_v1"` for this version of the API.
   */
  readonly engine_schema_version: string;

  /** Optional decision snapshot for external reproducibility. */
  readonly decisionSnapshot?: DecisionSnapshot | undefined;

  /** Optional debug reference strings for pipeline tracing. */
  readonly debugRefs?: readonly string[] | undefined;

  /**
   * Deterministic SHA-256 hex hash of key response fields
   * (canonical serialization; RFC-009 §8 / RFC-015).
   */
  readonly response_hash?: string | undefined;

  /**
   * E1-T5: 16-char hex determinism fingerprint identifying the exact engine configuration
   * (planner version, model, fusion config, ranking config). Two responses with the same
   * fingerprint MUST produce identical rankings given the same index state.
   * Omitted when fingerprint params are not supplied at call sites.
   */
  readonly determinism_fingerprint?: string | undefined;

  /** Deterministic authority id (mirrors `engineDecision.authorityTraceRef`). */
  readonly authorityTraceRef?: string | undefined;

  /** Non-authoritative correlation (e.g. request id) for logs and support. */
  readonly runtimeCorrelationRef?: string | undefined;

  readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';

  readonly blockingEligible?: boolean;

  readonly degradationReasons?: readonly string[] | undefined;

  /** Canonical retrieval provenance slices for runtime/eval SSOT. */
  readonly retrievalProvenanceSlices?: readonly EvalProvenanceSlice[] | undefined;

  /** Structured specialized route provenance for runtime/eval SSOT. */
  readonly specializedRouteRequested?: SpecializedRouteName | null | undefined;

  readonly specializedRouteExecuted?: SpecializedRouteName | null | undefined;

  readonly fallbackApplied?: boolean | undefined;

  readonly fallbackReason?: SpecializedFallbackReason | null | undefined;

  /** Stable execution-contract projection for downstream observability/debugging. */
  readonly executionContract?: ExecutionContractMeta | undefined;

  /** Stable provenance closure for public consumers. */
  readonly provenanceTrace?: ProvenanceTraceMeta | undefined;

  /**
   * Optional audit payload populated when `options.explain = true` on the request.
   * Contains planner policy traces and other per-request debug data.
   * Omitted on normal requests to keep response payloads lean.
   */
  readonly auditExtension?: AuditExtension | undefined;
}
