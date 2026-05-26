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
 * Inferred constraints are weaker than explicit soft constraints by design.
 * Their boost weight is the originating confidence scaled by this factor.
 *
 * EXPORTED so tests assert against the SOURCE value (not a test-local copy) —
 * a divergent test constant would let a silent weight regression pass.
 * Must be in (0,1]: 0 would erase inferred signal entirely; >1 would make
 * inferred boosts *stronger* than soft, inverting the tier semantics.
 */
export declare const INFERRED_CONSTRAINT_WEIGHT_MULTIPLIER = 0.7;
/**
 * Upper bound on the number of boost signals emitted per tier (soft / inferred).
 *
 * A retrieval plan is a bounded artifact: the ranker applies every boost as a
 * weighted-sum term per candidate, so an unbounded boost list is both a
 * latency hazard (O(candidates × boosts)) and an audit hazard (an adversarial
 * or buggy upstream could emit thousands of constraints). The cap is generous
 * relative to the largest legitimate constraint bundle observed (≤ ~20 atoms
 * across hard/soft/inferred) so it never clips real intent, while bounding the
 * worst case. Excess boosts are dropped DETERMINISTICALLY — highest weight
 * first, then by stable comparator — so the strongest signals always survive.
 */
export declare const MAX_BOOSTS_PER_TIER = 64;
/**
 * Lower/upper bounds for any boost weight emitted in a plan. The {@link BoostSignal}
 * contract documents `weight ∈ [0,1]`; upstream `confidence` is NOT guaranteed
 * to be finite or in-range (LLM-sourced constraints can emit 1.5, NaN, -0.2).
 * Every weight is clamped to [WEIGHT_MIN, WEIGHT_MAX] so the documented
 * invariant actually holds and downstream weighted sums never see NaN/∞.
 */
export declare const BOOST_WEIGHT_MIN = 0;
export declare const BOOST_WEIGHT_MAX = 1;
/**
 * Build a structured retrieval plan from a constraint bundle.
 *
 * Hard constraints → existing filter tokens (unchanged path).
 * Soft constraints → boost signals with weight = clamped confidence.
 * Inferred constraints → boost signals (weight × multiplier) AND sensory
 * priors (when the attribute is numeric-sensory).
 *
 * Determinism / SOTA invariants enforced here:
 *  - **Order-independence**: boosts are sorted by a content-only comparator,
 *    so permuting the input arrays never changes the output.
 *  - **Bounded fan-out**: each tier is capped at {@link MAX_BOOSTS_PER_TIER},
 *    dropping the WEAKEST signals first (deterministic).
 *  - **Weight invariant**: every weight is clamped to [0,1] — NaN/∞/out-of-range
 *    confidences can never leak into downstream weighted sums.
 *  - **NFC preservation**: Korean/accented string values are NFC-normalized so
 *    the same logical query always produces the same plan.
 */
export declare function buildRetrievalPlan(bundle: ConstraintBundle): RetrievalPlan;
/** Plan version constant (for trace). */
export declare function retrievalPlanVersion(): string;
//# sourceMappingURL=retrieval-plan-builder.d.ts.map