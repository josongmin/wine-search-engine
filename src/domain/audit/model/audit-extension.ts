/**
 * E8: AuditExtension — structured audit envelope attached to search responses.
 *
 * Extends the existing `meta` + `engine_decision` + `decision_snapshot` surface
 * with per-execution trace payloads from EPIC-3 through EPIC-7.
 *
 * Field gating policy:
 *  - determinism_fingerprint        always included (in meta, not here)
 *  - planner_policy_trace           explain=true OR debug header
 *  - constraint_resolution_trace    explain=true OR debug header
 *  - retrieval_fusion_trace         explain=true OR debug header
 *  - ranking_delta_trace            LTR applied + explain=true
 *  - rerank_decision_trace          LTR applied + explain=true
 *  - abstain_policy_trace           always when abstain occurs
 *  - fallback_trace                 always when agent fallback occurs
 *
 * No parallel audit envelope — this is attached to SearchResponseMeta.audit_extension.
 */

import type { PolicyDecisionRecord } from '../../query/model/policy-decision-record.js';
import type { ConstraintAtom } from '../../shared/types/constraint-atom.js';
import type { ConstraintRelation } from '../../query/service/constraint-reasoner.js';
import type { RrfFusionTrace, CandidateDropRecord } from '../../retrieval/model/candidate-envelope.js';
import type { ScoreDriftRecord } from '../../ranking/model/score-decomposition.js';
import type { TypedAbstainDecision, ChannelDegradationSummary } from '../../query/model/abstain-decision.js';

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
 * Rerank gate decision outcome — was LTR reranking applied?
 */
export type RerankGateDecision = 'applied' | 'skipped_ltr_unavailable' | 'skipped_kill_switch' | 'skipped_safety_blocked';

// ─── AuditExtension ──────────────────────────────────────────────────────────

/**
 * E8: Full audit extension envelope.
 *
 * All fields are optional — consumers MUST NOT assume any field is present.
 * Fields are populated lazily based on execution path and gating policy.
 */
export interface AuditExtension {
  /**
   * E3: Planner policy trace — one record per decision stage.
   * Gated: explain=true or debug header.
   */
  readonly planner_policy_trace?: readonly PolicyDecisionRecord[] | undefined;

  /**
   * E2: Constraint resolution trace — atoms, relations, and outcomes.
   * Gated: explain=true or debug header.
   */
  readonly constraint_resolution_trace?: {
    readonly atoms: readonly ConstraintAtom[];
    readonly relations: readonly ConstraintRelation[];
    readonly policy_outcomes: readonly PolicyOutcome[];
  } | undefined;

  /**
   * E4: RRF fusion trace — per-query fusion parameters and candidate counts.
   * Gated: explain=true or debug header.
   */
  readonly retrieval_fusion_trace?: RrfFusionTrace | undefined;

  /**
   * E5: Ranking delta trace — pre/post rerank positions + Kendall tau drift.
   * Gated: LTR applied + explain=true.
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
   */
  readonly hard_filter_drop_log?: readonly CandidateDropRecord[] | undefined;

  /**
   * TA5: Calibrated posterior confidence from corrective retry (TA5).
   * Present when a corrective retry was accepted; undefined otherwise.
   * Range: [0.5, 0.9] — 0.9 at rank 1, 0.5 at rank N.
   */
  readonly corrective_retry_calibrated_confidence?: number | undefined;

  /**
   * Agent fallback trace — always emitted when agent fallback occurs.
   * Present when the agent pipeline fell back to layer2/3/4 or a search fallback.
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
