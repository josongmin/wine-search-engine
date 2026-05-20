/**
 * E3: Planner Policy Trace — machine-readable record of each planner
 * decision stage. Present in QueryPlanV2.plannerTrace when tracing is enabled.
 */
export interface RuleMatch {
    /** Stable identifier for the rule (e.g. 'route.entity_exact.strong_anchor'). */
    readonly ruleId: string;
    /** Human-readable description of the rule. */
    readonly description: string;
    /** The input facts that triggered this rule. */
    readonly inputsMatched: Readonly<Record<string, unknown>>;
    /** The decision outcome this rule produced. */
    readonly outcome: string;
}
export interface RuleMiss {
    /** Stable identifier for the rule. */
    readonly ruleId: string;
    /** Human-readable description. */
    readonly description: string;
    /** Why this rule was not selected. */
    readonly failedCondition: string;
}
export type PlannerStage = 'intent_classification' | 'route_resolution' | 'retrieval_mode_selection' | 'query_class_classification' | 'uncertainty_estimation' | 'target_entity_inference';
export interface PolicyDecisionRecord {
    /** Which planner stage this record describes. */
    readonly stage: PlannerStage;
    /** Snapshot of facts visible at entry to this stage. */
    readonly inputFacts: Readonly<Record<string, unknown>>;
    /** All rules evaluated (in evaluation order). */
    readonly rulesEvaluated: readonly RuleMatch[];
    /** Branches evaluated but not selected. */
    readonly rejectedBranches: readonly RuleMiss[];
    /** The final decision value (e.g. 'entity_exact', 'hybrid', 'specific_wine'). */
    readonly decision: string;
    /** Confidence in this decision [0, 1]. */
    readonly confidence: number;
    /** Wall-clock time for this stage in ms, when measured. */
    readonly durationMs?: number | undefined;
}
//# sourceMappingURL=policy-decision-record.d.ts.map