import type { QueryClass, ConstraintBundle, ConstraintAtom } from '../../shared/types/index.js';
import type { QueryIntent } from './query-intent.js';
import type { QueryRoute } from './query-route.js';
import type { RetrievalMode } from './retrieval-mode.js';
import type { AnchorCandidate } from './anchor-candidate.js';
import type { QueryPolicy } from './query-policy.js';
import type { QueryUncertainty } from './query-uncertainty.js';
import type { ExpansionBundle } from './constraint-bundle.js';
import type { SessionContext } from './session-context.js';
import type { QueryBudget } from './query-budget.js';
import type { QueryTargetType } from './query-target-type.js';
import type { NormalizedQueryViews } from './query-views.js';
import type { QueryUnderstandingSnapshot } from './query-understanding-snapshot.js';
import type { QueryDecompositionHint } from './query-decomposition.js';
import type { ConstraintExtractionTrace } from '../../attribute/model/constraint-extraction-trace.js';
import type { RetrievalPlan } from '../../retrieval/service/retrieval-plan-builder.js';
import type { RetrievalObjective } from '../../retrieval/model/retrieval-objective.js';
import type { PolicyDecisionRecord } from './policy-decision-record.js';
import type { ConstraintGraph } from './constraint-graph.js';
import type { AmbiguityIntentTrace } from './ambiguity-intent-interpretation.js';
/**
 * Version 1 of the Query Plan -- the single source of truth (SSOT) output
 * of the Query Planner domain.
 *
 * A QueryPlanV1 is an immutable, deterministic snapshot: given the same input
 * query, planner version, and policy rule version, the plan is identical.
 *
 * Downstream consumers (resolver, scorer, abstention layer) read only from
 * the query plan and never re-derive planning decisions.
 *
 * ⚠️  FIELD FREEZE (E1-U9 / apr-7-v0.4)
 * QueryPlanV1 is a **compatibility-only surface**. Do NOT add new fields here.
 * Execution decisions (route, mode, budget, provenance policy) belong in
 * {@link EngineExecutionContract} produced by {@link ExecutionCompiler}.
 * Understanding fields (intent, queryClass, anchors, etc.) belong in
 * {@link QueryUnderstandingSnapshot} inside {@link CompiledWineQuery}.
 * New planner outputs go into {@link QueryPlanV2} and flow through
 * ExecutionCompiler → CompiledWineQuery. V1 will be removed in T1.5.
 */
export interface QueryPlanV1 {
    /** The original user query string, unmodified. */
    readonly rawQuery: string;
    /** Lowercased, whitespace-collapsed, accent-stripped query. */
    readonly normalizedQuery: string;
    /**
     * Multi-view normalization snapshot used for noisy entity lookup.
     *
     * This is surfaced for debugging and provenance only; downstream logic
     * should continue to rely on normalizedQuery for deterministic behavior.
     */
    readonly normalizedQueryViews?: NormalizedQueryViews | undefined;
    /** Primary intent classification for this query. */
    readonly intent: QueryIntent;
    /** Additional intents detected (RFC-005 section 3.2.1 multi-intent). */
    readonly secondaryIntents?: readonly QueryIntent[] | undefined;
    /** Routing target for downstream execution. */
    readonly route: QueryRoute;
    /** Retrieval mode: fine-grained strategy beyond route (RFC-017 §8.3). */
    readonly retrievalMode: RetrievalMode;
    /** Query class label used to select thresholds from the threshold profile. */
    readonly queryClass: QueryClass;
    /** Anchor entities extracted from the query surface form. */
    readonly anchors: readonly AnchorCandidate[];
    /** Hard, soft, and inferred constraints parsed from the query. */
    readonly constraints: ConstraintBundle;
    /** Lexical and semantic expansion terms. */
    readonly expansions: ExpansionBundle;
    /** Compiled policy directives for downstream resolvers. */
    readonly policy: QueryPolicy;
    /** Uncertainty assessment across parsing, anchoring, and constraints. */
    readonly uncertainty: QueryUncertainty;
    /** Semantic version of the planner that produced this plan. */
    readonly plannerVersion: string;
    /** Semantic version of the policy rules used during compilation. */
    readonly policyRuleVersion: string;
    /** ID of the threshold profile referenced by this plan. */
    readonly thresholdProfileId: string;
    /**
     * Surfaces what evidence/sealing the Admission Gate requires for this query
     * (RFC-005 §3.1, RFC-016 §2). Populated by the Planner; consumed by AdmissionGate.
     */
    readonly admission_context?: {
        /** True for entity_exact / entity_fuzzy / comparison / mixed routes. */
        readonly requires_identity_seal: boolean;
        /** True when hard constraints are present (constraint evidence required). */
        readonly requires_constraint_evidence: boolean;
        /** True for mixed-query route with anchors (anchor evidence required). */
        readonly requires_anchor_evidence: boolean;
    } | undefined;
    /** Optional session context for multi-turn queries. */
    readonly sessionContext?: SessionContext | undefined;
    /** Optional resource budget constraints. */
    readonly queryBudget?: QueryBudget | undefined;
    /** Optional decomposition hint for decomposition-aware execution. */
    readonly decompositionHint?: QueryDecompositionHint | undefined;
    /** Inferred target entity type for result grouping (Epic 8). */
    readonly targetEntityType?: QueryTargetType | undefined;
}
/**
 * Version 2 of the Query Plan.
 *
 * Planner-only output. Does NOT include execution decisions (route, retrievalMode).
 * Those are compiled by ExecutionCompiler into EngineExecutionContract.
 *
 * QueryPlanV2 = QueryUnderstandingSnapshot + admission_context + planner suggestions
 */
export interface QueryPlanV2 {
    readonly rawQuery: string;
    readonly normalizedQuery: string;
    readonly normalizedQueryViews?: NormalizedQueryViews;
    readonly intent: QueryIntent;
    readonly secondaryIntents?: readonly QueryIntent[];
    readonly anchors: readonly AnchorCandidate[];
    readonly constraints: ConstraintBundle;
    readonly expansions: ExpansionBundle;
    readonly uncertainty: QueryUncertainty;
    readonly queryClass: QueryClass;
    readonly targetEntityType?: QueryTargetType;
    readonly plannerVersion: string;
    readonly policyRuleVersion: string;
    readonly thresholdProfileId: string;
    readonly sessionContext?: SessionContext;
    readonly queryBudget?: QueryBudget;
    readonly decompositionHint?: QueryDecompositionHint;
    /** NL constraint extraction provenance (rule vs LLM); request-scoped, not read from singletons. */
    readonly constraintExtraction?: ConstraintExtractionTrace | undefined;
    /** Structured retrieval plan built from compiled constraints. */
    readonly retrievalPlan?: RetrievalPlan | undefined;
    /** Structured latent retrieval objective built from intent-bearing constraints. */
    readonly retrievalObjective?: RetrievalObjective | undefined;
    /**
     * E2-T3: ConstraintAtom IR — flat list of atoms produced by ConstraintReasoner.
     *
     * Present when the planner ran ConstraintReasoner after Tier 6 extraction.
     * Absent for legacy/V1 plan paths that have not been upgraded yet.
     *
     * Consumers (Ranker, Safety Envelope) that need conflict-resolved constraints
     * MUST prefer this list when present. Fall back to `constraints` (raw bundle)
     * when absent.
     */
    readonly constraintAtoms?: readonly ConstraintAtom[] | undefined;
    /**
     * ADR-010 Phase 1a: ConstraintGraph — super-structure over
     * `constraintAtoms`. Slot nodes reference atoms by `atomRef` (stringified
     * index into `constraintAtoms`); edges carry grouping / budget / ordering
     * topology that atoms cannot express.
     *
     * Phase 1a emits a trivial graph (one `group_and` root over every atom).
     * Phase 1b will upgrade the projector with LLM-emitted topology (XOR,
     * shared budgets, multi-subquery decomposition).
     *
     * Optional: absent when the feature flag `CONSTRAINT_GRAPH_EMIT` is off
     * or when there are no atoms. Phase 1a readers remain on
     * `constraints` / `constraintAtoms`; do NOT migrate to this field yet.
     */
    readonly constraintGraph?: ConstraintGraph | undefined;
    /**
     * E3: Planner policy trace — machine-readable record of each decision stage.
     *
     * Present when the planner ran with tracing enabled (debug header or explain=true).
     * Absent in production hot-path (tracing is opt-in to avoid allocation overhead).
     *
     * Consumers MUST treat this as optional. Core plan fields are the source of truth;
     * plannerTrace is additive observability only.
     */
    readonly plannerTrace?: readonly PolicyDecisionRecord[] | undefined;
    /** Ambiguity-intent compiler trace for deterministic→LLM understanding handoff. */
    readonly ambiguityIntentTrace?: AmbiguityIntentTrace | undefined;
    readonly admission_context?: {
        readonly requires_identity_seal: boolean;
        readonly requires_constraint_evidence: boolean;
        readonly requires_anchor_evidence: boolean;
    };
    /** Planner's suggested route — compiler may override. */
    readonly suggestedRoute: QueryRoute;
    /** Planner's suggested retrieval mode — compiler may override. */
    readonly suggestedRetrievalMode: RetrievalMode;
}
/**
 * Convert QueryPlanV2 to QueryUnderstandingSnapshot.
 *
 * Intentionally drops: route/mode suggestions, admission_context, and plannerTrace.
 * - Route/mode are execution decisions, not understanding.
 * - plannerTrace is diagnostic only — QueryUnderstandingSnapshot is the
 *   understanding SSOT and must not carry execution-phase observability data.
 *   Consumers that need the trace must retain the full QueryPlanV2.
 */
export declare function planV2ToUnderstandingSnapshot(plan: QueryPlanV2): QueryUnderstandingSnapshot;
//# sourceMappingURL=query-plan.d.ts.map