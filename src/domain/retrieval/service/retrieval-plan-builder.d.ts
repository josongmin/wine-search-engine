/**
 * RFC-019 Stage 6: Retrieval Plan Builder
 *
 * Converts a ConstraintBundle into a structured RetrievalPlan with three
 * distinct tiers:
 *
 *   1. HARD filter tokens (Vespa YQL WHERE clauses) — gating
 *   2. SOFT boost tokens (post-retrieval ranking features) — scoring
 *   3. INFERRED expansion tokens (ranking features + sensory priors) — priors
 *
 * The existing pipeline conflates soft and inferred: both flow to
 * `computeSoftConstraint()` with inferred at INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER
 * (currently 0.7x) weight. This module separates
 * them structurally so the ranker can weight them independently and so the
 * downstream RFC-018 drinking window predictor can consume inferred sensory
 * priors as fallbacks for missing index values.
 *
 * Design contract (RFC-019 §6.6):
 *   - Hard filters are UNCHANGED (same tokens as hardConstraintsToSparseFilterTokens)
 *   - Soft boosts are a new STRUCTURED list — not flat YQL, stay in memory
 *   - Inferred expansions are SEPARATED from soft and can include sensory
 *     priors (tannin/body/acidity/sweetness) for Phase 7 integration
 */
import type { ConstraintBundle, NormalizedConstraint } from '../../shared/types/index.js';
/** A scoring boost/expansion signal derived from a constraint. */
export interface BoostSignal {
    /** The attribute name (e.g. 'grape_family', 'tannin'). */
    readonly attribute: string;
    /** The target value for matching. */
    readonly value: NormalizedConstraint['value'];
    /** Operator for matching (e.g. '=', 'in', '>='). */
    readonly operator: NormalizedConstraint['operator'];
    /** Score contribution weight in [0,1]. Higher = stronger boost. */
    readonly weight: number;
    /** Provenance (source constraint's mapping_version). */
    readonly source: string;
}
/** Inferred sensory prior — fallback for missing index values (RFC-018 integration). */
export interface SensoryPrior {
    readonly attribute: 'body' | 'tannin' | 'acidity' | 'sweetness';
    /** Target value on normalized [0,1] scale. */
    readonly value: number;
    /** Confidence of the prior (originating constraint's confidence). */
    readonly confidence: number;
    /** Source — which composition rule or ontology edge produced this. */
    readonly source: string;
}
/** Structured retrieval plan — three tiers. */
export interface RetrievalPlan {
    /** Hard YQL filter tokens — gating. */
    readonly hardFilterTokens: readonly string[];
    /** Soft boost signals — applied post-retrieval by ranker. */
    readonly softBoosts: readonly BoostSignal[];
    /** Inferred expansion boosts — independent weight from soft. */
    readonly inferredBoosts: readonly BoostSignal[];
    /** Sensory priors for RFC-018 fallback (body/tannin/acidity/sweetness). */
    readonly sensoryPriors: readonly SensoryPrior[];
    /** Plan version for replay parity. */
    readonly planVersion: string;
}
/**
 * Build a structured retrieval plan from a constraint bundle.
 *
 * Hard constraints → existing filter tokens (unchanged path).
 * Soft constraints → boost signals with weight proportional to confidence.
 * Inferred constraints → boost signals AND sensory priors (if applicable).
 */
export declare function buildRetrievalPlan(bundle: ConstraintBundle): RetrievalPlan;
/** Plan version constant (for trace). */
export declare function retrievalPlanVersion(): string;
//# sourceMappingURL=retrieval-plan-builder.d.ts.map