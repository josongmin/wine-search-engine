import type { ConstraintExtractionTrace } from '../../attribute/model/constraint-extraction-trace.js';
import type { QueryPlanV1, QueryPlanV2 } from './query-plan.js';
import type { CompiledWineQuery } from './compiled-wine-query.js';
import type { AmbiguityIntentTrace } from './ambiguity-intent-interpretation.js';
/**
 * Type guard that distinguishes a QueryPlanV2 from a QueryPlanV1.
 *
 * V2 carries `suggestedRoute` + `suggestedRetrievalMode` (planner hints, NOT
 * bound execution decisions) and does NOT carry V1's `route` / `retrievalMode`.
 * Checking both conditions prevents misclassification if a V1 plan is ever
 * accidentally spread with extra keys (e.g. `{ ...v1Plan, suggestedRoute: ... }`).
 */
export declare function isQueryPlanV2(plan: QueryPlanV1 | QueryPlanV2): plan is QueryPlanV2;
export declare const QUERY_FAMILY_LABELS: readonly ["entity_exact", "entity_fuzzy", "entity_resolution", "attribute_constrained", "producer_browse", "region_browse", "comparison", "recommendation", "pairing", "multi_intent", "no_match", "ambiguous", "unknown"];
export type QueryFamilyLabel = (typeof QUERY_FAMILY_LABELS)[number];
type PlanLike = QueryPlanV1 | QueryPlanV2;
/** Constraint extraction provenance — tracks rule vs LLM hit rates. */
export type ConstraintExtractionObservability = ConstraintExtractionTrace;
export interface QueryObservabilitySlice {
    readonly queryId: string;
    readonly rawQuery: string;
    readonly queryFamily: QueryFamilyLabel;
    readonly intent: string;
    readonly queryClass: string;
    readonly suggestedRetrievalMode: string;
    readonly suggestedRoute: string;
    readonly anchorCount: number;
    readonly hardConstraintCount: number;
    readonly softConstraintCount: number;
    readonly overallUncertainty: number;
    readonly ambiguityDetected: boolean;
    readonly plannerVersion: string;
    readonly policyRuleVersion: string;
    readonly thresholdProfileId: string;
    readonly decompositionStrategy?: string | undefined;
    readonly decompositionConfidence?: number | undefined;
    /** Constraint extraction provenance (populated when LlmNLMapper is active). */
    readonly constraintExtraction?: ConstraintExtractionObservability | undefined;
    readonly ambiguityIntentSource?: AmbiguityIntentTrace['source'] | undefined;
    readonly ambiguityIntentLatencyMs?: number | null | undefined;
    readonly ambiguityIntentBranchSelectionCount?: number | undefined;
    readonly ambiguityIntentSelectedBranchCount?: number | undefined;
    readonly ambiguityIntentQueryClassOverride?: string | undefined;
}
export declare function deriveQueryFamily(plan: PlanLike, compiled?: CompiledWineQuery): QueryFamilyLabel;
/**
 * Build the query observability slice. Resolution order for `constraintExtraction`:
 * 1. Explicit 4th argument (when callers need an override).
 * 2. `plan.constraintExtraction` when `plan` is QueryPlanV2.
 * 3. `compiled.query.constraintExtraction` (ExecutionCompiler copy of planner output).
 */
export declare function planToObservabilitySlice(queryId: string, plan: PlanLike, compiled?: CompiledWineQuery, constraintExtraction?: ConstraintExtractionObservability): QueryObservabilitySlice;
export {};
//# sourceMappingURL=query-observability-vocab.d.ts.map