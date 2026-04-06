import type { NormalizedQueryViews } from '../../query/model/query-views.js';

/**
 * Query-side provenance preserved in decision traces for noisy lookup debugging.
 */
export interface DecisionQueryProvenance {
  /** Multi-view normalization snapshot used during lookup. */
  readonly normalizedQueryViews?: NormalizedQueryViews | undefined;

  /** Lookup variants that contributed to anchor extraction. */
  readonly anchorLookupVariants?: readonly string[] | undefined;

  /** Lookup strategies that contributed to anchor extraction. */
  readonly anchorLookupStrategies?: readonly string[] | undefined;
}

/**
 * A complete diagnostic trace of a decision, per RFC-007 §9.
 *
 * Every decision path through the {@link DecisionEngine} MUST produce
 * a complete trace. This enables exact reproducibility analysis,
 * regression triage, and audit trails.
 */
export interface DecisionTrace {
  /** The final decision status (resolved, ambiguous, failed). */
  readonly decisionStatus: string;

  /** The prescribed next action (return_result, clarify, hybrid_search, fail). */
  readonly nextAction: string;

  /** Key inputs that influenced the decision. */
  readonly inputs: {
    /** The query class that determined threshold selection. */
    readonly queryClass: string;
    /** The route that actually executed after API overrides. */
    readonly effectiveRoute?: string | undefined;
    /** Policy directives active during decision-making. */
    readonly policy: Readonly<Record<string, unknown>>;
  };

  /** Numeric signals that fed into the decision gates. */
  readonly signals: {
    /** The calibrated decision confidence C. */
    readonly decisionConfidence: number;
    /** Gap between top-1 and top-2 calibrated scores. */
    readonly calibratedGap: number;
    /** Whether ambiguity was detected. */
    readonly ambiguity: boolean;
  };

  /** Threshold values that were compared against. */
  readonly thresholds: {
    /** T_resolve(Q): minimum confidence for resolution. */
    readonly resolveThreshold: number;
    /** T_gap(Q): minimum gap for resolution. */
    readonly gapThreshold: number;
  };

  /** Version identifiers for reproducibility. */
  readonly versions: {
    /** Version of the query planner that produced the plan. */
    readonly plannerVersion?: string;
    /** Version of the policy rules applied. */
    readonly policyRuleVersion: string;
    /** ID of the threshold profile used. */
    readonly thresholdProfileId: string;
  };

  /** Machine-readable identifiers of rules that fired during decision-making. */
  readonly rulesApplied: readonly string[];

  /** Human-readable explanation of why this decision was reached. */
  readonly finalReason: string;

  /** Query-side provenance carried forward from the resolver stage. */
  readonly queryProvenance?: DecisionQueryProvenance | undefined;
}
