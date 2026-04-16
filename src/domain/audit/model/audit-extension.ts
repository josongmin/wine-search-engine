/**
 * E8: AuditExtension — structured audit envelope attached to search responses.
 *
 * Extends the existing `meta` + `engine_decision` + `decision_snapshot` surface
 * with per-execution trace payloads from EPIC-3 through EPIC-7.
 *
 * ## T-E5-03: Stable vs Debug Field Boundary
 *
 * Fields in this envelope fall into two categories:
 *
 * ### Stable fields (always emitted when their trigger condition is met)
 * These are part of the **public API contract**. Clients MAY depend on their
 * presence and shape. Removing or renaming them is a breaking change.
 *
 *  | Field                                  | Trigger                              |
 *  |----------------------------------------|--------------------------------------|
 *  | abstain_policy_trace                   | always when abstain occurs           |
 *  | fallback_trace                         | always when agent fallback occurs    |
 *  | hard_filter_drop_log                   | always when hard-filter drops occur  |
 *  | corrective_retry_calibrated_confidence | always when corrective retry accepted|
 *  | determinism_fingerprint                | always (normally in meta, not here)  |
 *
 * ### Debug-only fields (gated by `explain=true` or `X-Debug-Key` header)
 * These are **debug sidecar** data. Clients MUST NOT depend on their presence
 * in production responses. Their shape may change without notice.
 *
 *  | Field                       | Gate                                    |
 *  |-----------------------------|-----------------------------------------|
 *  | planner_policy_trace        | explain=true OR debug header            |
 *  | constraint_resolution_trace | explain=true OR debug header            |
 *  | retrieval_fusion_trace      | explain=true OR debug header            |
 *  | ranking_delta_trace         | LTR applied + explain=true              |
 *  | rerank_decision_trace       | LTR applied + explain=true              |
 *  | execution_trace             | explain=true OR debug header            |
 *  | resolver_provenance_trace   | explain=true OR debug header            |
 *
 * No parallel audit envelope — this is attached to SearchResponseMeta.audit_extension.
 */

import type { PolicyDecisionRecord } from '../../query/model/policy-decision-record.js';
import type { QueryRoute } from '../../query/model/query-route.js';
import type {
  ExecutionProvenanceClosure,
  ExecutionRetrievalMode,
} from '../../query/model/engine-execution-contract.js';
import type { ConstraintAtom } from '../../shared/types/constraint-atom.js';
import type { ConstraintRelation } from '../../query/service/constraint-reasoner.js';
import type { RrfFusionTrace, CandidateDropRecord } from '../../retrieval/model/candidate-envelope.js';
import type { ScoreDriftRecord } from '../../ranking/model/score-decomposition.js';
import type { RerankDecisionCode } from '../../ranking/port/ranker.port.js';
import type { TypedAbstainDecision, ChannelDegradationSummary } from '../../query/model/abstain-decision.js';
import type { SpecializedRouteName } from '../../response/model/specialized-route.js';

// ─── Supporting sub-types ─────────────────────────────────────────────────────

/**
 * Outcome of a single constraint policy evaluation during constraint resolution.
 */
export interface PolicyOutcome {
  /** The atom index this outcome applies to. */
  readonly atomIndex: number;
  /** What happened to this atom ('kept' | 'dropped' | 'shadowed'). */
  readonly outcome: 'kept' | 'dropped' | 'shadowed';
  /** Human-readable reason for the outcome. */
  readonly reason: string;
}

/**
 * Audit-surface alias for the single rerank decision code owned by the ranking port.
 */
export type RerankGateDecision = RerankDecisionCode;

// ─── AuditExtension ──────────────────────────────────────────────────────────

/**
 * E8: Full audit extension envelope.
 *
 * All fields are optional — consumers MUST NOT assume any field is present.
 * Fields are populated lazily based on execution path and gating policy.
 */
export interface AuditExtension {
  /**
   * Request-level execution contract facts emitted in debug/explain traces.
   * Lets operators inspect route/mode/budget/provenance without correlating
   * multiple pipeline log lines.
   *
   * @stability debug — gated by explain=true or debug header.
   */
  readonly execution_trace?: {
    readonly effective_route: QueryRoute;
    readonly retrieval_mode_source?: 'planner' | 'api_override' | undefined;
    readonly effective_retrieval_mode?: ExecutionRetrievalMode | undefined;
    readonly retrieval_kind?:
      | 'entity_lookup'
      | 'generic_hybrid'
      | 'specialized_hybrid'
      | 'mixed_similarity'
      | undefined;
    readonly sparse_executed?: boolean | undefined;
    readonly specialized_route_executed?: SpecializedRouteName | null | undefined;
    readonly used_compiled_execution?: boolean | undefined;
    readonly compiled_budget?: {
      readonly max_candidates: number;
      readonly rerank_limit: number;
      readonly enable_precision_rerank: boolean;
    } | undefined;
    readonly provenance_policy?: {
      readonly require_identity_seal: boolean;
      readonly require_constraint_evidence: boolean;
      readonly require_anchor_evidence: boolean;
    } | undefined;
    readonly provenance_closure?: ExecutionProvenanceClosure | undefined;
  } | undefined;

  /**
   * E3: Planner policy trace — one record per decision stage.
   * Gated: explain=true or debug header.
   *
   * @stability debug — not part of the public API contract.
   */
  readonly planner_policy_trace?: readonly PolicyDecisionRecord[] | undefined;

  /**
   * E2: Constraint resolution trace — atoms, relations, and outcomes.
   * Gated: explain=true or debug header.
   *
   * @stability debug — not part of the public API contract.
   */
  readonly constraint_resolution_trace?: {
    readonly atoms: readonly ConstraintAtom[];
    readonly relations: readonly ConstraintRelation[];
    readonly policy_outcomes: readonly PolicyOutcome[];
  } | undefined;

  /**
   * E4: RRF fusion trace — per-query fusion parameters and candidate counts.
   * Gated: explain=true or debug header.
   *
   * @stability debug — not part of the public API contract.
   */
  readonly retrieval_fusion_trace?: RrfFusionTrace | undefined;

  /**
   * E5: Ranking delta trace — pre/post rerank positions + Kendall tau drift.
   * Gated: LTR applied + explain=true.
   *
   * @stability debug — not part of the public API contract.
   */
  readonly ranking_delta_trace?: {
    /** Top-5 entity IDs before LTR reranking. */
    readonly preRerankTop5: readonly string[];
    /** Top-5 entity IDs after LTR reranking. */
    readonly postRerankTop5: readonly string[];
    /** Number of candidates blocked by the safety envelope. */
    readonly safetyEnvelopeBlocks: number;
    /** Number of protected candidate evictions prevented. */
    readonly protectedCandidateEvictions?: number | undefined;
    /** Kendall tau drift record from ScoreDriftRecord. */
    readonly drift: ScoreDriftRecord;
  } | undefined;

  /**
   * Rerank gate decision — was LTR applied, skipped, or blocked?
   * Gated: LTR applied + explain=true.
   *
   * @stability debug — not part of the public API contract.
   */
  readonly rerank_decision_trace?: {
    readonly gateDecision: RerankGateDecision;
    readonly appliedModel?: string | undefined;
    readonly ltrFeatureDimension?: number | undefined;
    /** Score contract guarantee for LTR output scores. */
    readonly scoreContract?: 'bounded_normalized_0_1' | undefined;
    /** Count of candidates blocked per safety rule type. */
    readonly blockedReasonCounts?: Readonly<Record<string, number>> | undefined;
  } | undefined;

  /**
   * E6: Abstain policy trace — always emitted when abstain occurs.
   * Present whenever TypedAbstainDecision.shouldAbstain === true.
   *
   * @stability stable — part of the public API contract.
   */
  readonly abstain_policy_trace?: {
    readonly evaluated: boolean;
    /** The typed decision (or false if not abstaining). */
    readonly decision: TypedAbstainDecision | false;
    /** Normalized Shannon entropy of top-K scores (if entropy gate was evaluated). */
    readonly topKEntropy?: number | undefined;
    /** Constraint relations that contributed to the decision. */
    readonly constraintConflicts?: readonly ConstraintRelation[] | undefined;
    /** Channel degradation state at time of evaluation. */
    readonly channelDegradation?: ChannelDegradationSummary | undefined;
  } | undefined;

  /**
   * E4: Hard-filter dropout log — top-5 candidates dropped by hard constraint filter.
   * Always emitted when at least one candidate was dropped; sampled to top-5 drops
   * (ordered by lastKnownScore desc) to keep the payload lean.
   * Gated: populated whenever hard-filter drops occur, regardless of explain flag.
   *
   * @stability stable — part of the public API contract.
   */
  readonly hard_filter_drop_log?: readonly CandidateDropRecord[] | undefined;

  /**
   * Exact-recovery resolver provenance surfaced for noisy entity lookup audit.
   * Present when resolver query provenance carries candidate source breakdown.
   *
   * @stability debug — gated by explain=true or debug header.
   */
  readonly resolver_provenance_trace?: {
    readonly candidate_source_breakdown?: readonly {
      readonly source: 'alias' | 'planner_heuristic' | 'entity_lookup' | 'blocker_seed';
      readonly entity_ids: readonly string[];
      readonly count: number;
    }[] | undefined;
    readonly blocker_seed_entity_ids?: readonly string[] | undefined;
    readonly blocker_seed_count?: number | undefined;
  } | undefined;

  /**
   * TA5: Calibrated posterior confidence from corrective retry (TA5).
   * Present when a corrective retry was accepted; undefined otherwise.
   * Range: [0.5, 0.9] — 0.9 at rank 1, 0.5 at rank N.
   *
   * @stability stable — part of the public API contract.
   */
  readonly corrective_retry_calibrated_confidence?: number | undefined;

  /**
   * Agent fallback trace — always emitted when agent fallback occurs.
   * Present when the agent pipeline fell back to layer2/3/4 or a search fallback.
   *
   * @stability stable — part of the public API contract.
   */
  readonly fallback_trace?: {
    /** Which fallback layer was applied, if any. */
    readonly fallbackApplied: 'layer2' | 'layer3' | 'layer4' | null;
    /** Whether a reasoning failure triggered the fallback. */
    readonly reasoningFailure: boolean;
    /** How many synthesis attempts failed before fallback. */
    readonly failedSynthesisAttempts: number;
    /** Whether a fallback search was used to produce the response. */
    readonly fallbackSearchUsed: boolean;
  } | undefined;
}
