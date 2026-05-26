import type { NormalizedConstraint } from '../../shared/types/index.js';
/**
 * Maps planner hard constraints to Vespa sparse filter tokens understood by
 * {@link buildSparseFilters} (`src/infrastructure/vespa/mapping.ts`).
 *
 * Skips attributes that cannot be expressed as index filters or would
 * duplicate lexical intent (e.g. free-text `region` without a schema filter).
 */
export declare function hardConstraintsToSparseFilterTokens(constraints: readonly NormalizedConstraint[]): readonly string[];
/**
 * Options controlling the confidence-gated promotion of soft constraints
 * into sparse filter tokens.
 */
interface SoftPromotionOptions {
    /**
     * Confidence floor (inclusive). Soft constraints with `confidence` below
     * this value are NEVER promoted. Defaults to
     * {@link SOFT_PROMOTION_DEFAULT_CONFIDENCE_FLOOR} (0.8).
     */
    readonly confidenceFloor?: number;
}
/**
 * P1.A + C1b — Confidence-gated promotion of SOFT constraints into Vespa
 * filter tokens.
 *
 * The constraint-compiler keeps high-confidence preference signals
 * (`critic_score`, `body`, `alcohol_pct`, `sweetness`, `flavor_profile`, …)
 * in {@link ConstraintBundle.soft} so the ranker can apply graceful penalties
 * rather than 0-result hard cuts. Historically these never reached YQL —
 * meaning queries like "평점 좋은 와인" (P1.A) and "저알콜 와인" (C1b)
 * never tightened retrieval below the full corpus.
 *
 * This function performs a NARROW, principled promotion: each soft constraint
 * is converted into the same `<key>_min` / `<key>_max` / `<key>:` filter
 * token used by hard constraints IFF every gate passes:
 *
 *   1. `confidence >= confidenceFloor` (default 0.8 — the tier-1/tier-2 floor)
 *   2. `mapping_version ∈ SOFT_PROMOTION_ALLOWED_MAPPING_VERSIONS`
 *      (deterministic curated/rule-based/entity-resolver outputs only —
 *      no LLM-sourced or planner-inferred promotion)
 *   3. `attribute ∈ SOFT_PROMOTION_TOKEN_SPEC` (only attributes with an
 *      explicit promotion spec — see {@link SoftPromotionSpec} for the
 *      attribute-level MIN/MAX/string semantics)
 *   4. The operator/value combination yields one of:
 *        - `=` / `>=` numeric value → MIN floor (if `spec.minKey` defined)
 *        - `<=` numeric value       → MAX ceiling (if `spec.maxKey` defined)
 *        - `range` { min, max }     → MIN floor + MAX ceiling (each gated on its
 *          spec key, so MIN-only attributes only emit the floor)
 *        - `=` string value         → `<key>:<value>` contains
 *        - `in` array of strings    → `<key>_in:<v1>|<v2>` multi-value OR
 *        - `exclude` / `not_in`     → skipped (negation is hard-pathed in
 *          `constraintToSparseFilterTokens` regardless of soft attribute)
 *
 * NEVER duplicates the YQL translation: the emitted token is consumed by
 * `buildSparseFilters` in `src/infrastructure/vespa/mapping.ts`, identical
 * to the hard-constraint path.
 *
 * @returns Filter tokens for the promoted constraints, in stable input order.
 */
export declare function softConstraintsToOptionalFilterTokens(constraints: readonly NormalizedConstraint[], options?: SoftPromotionOptions): readonly string[];
/**
 * Set of attribute names whose hard-constraint variants have an explicit `case`
 * branch in {@link constraintToSparseFilterTokens} — i.e. the compile path
 * KNOWS how to turn (attribute, operator, value) into one or more registered
 * Vespa filter tokens when used as a hard constraint.
 *
 * Kept in lock-step with the `switch (attribute)` block above. Adding a new
 * `case` branch REQUIRES adding the attribute here. The constraint validator
 * (`constraint-validator.ts`) consumes this SSoT so unrecognized attributes
 * can be detected at compile time rather than silently dropped at YQL
 * emission time.
 *
 * Tokens emitted by the compile path are themselves validated against
 * FILTER_TOKEN_REGISTRY in `mapping.ts` — this set names the planner-facing
 * attribute, not the Vespa-facing token key.
 */
export declare const HARD_FILTERABLE_ATTRIBUTES: ReadonlySet<string>;
/**
 * Set of attribute names that {@link softConstraintsToOptionalFilterTokens}
 * KNOWS how to promote into Vespa filter tokens when the soft-constraint
 * confidence/mapping-version gates pass. Derived from
 * {@link SOFT_PROMOTION_TOKEN_SPEC} so the validator stays in sync with the
 * promotion spec automatically.
 *
 * A constraint whose attribute is in {@link HARD_FILTERABLE_ATTRIBUTES} but
 * NOT in this set is "hard-only": placing it in the soft bundle means the
 * intent never reaches Vespa as a WHERE filter (it can only contribute to
 * ranking via the soft-boost path in `retrieval-plan-builder.ts`).
 */
export declare const SOFT_PROMOTABLE_ATTRIBUTES: ReadonlySet<string>;
/**
 * Classification of a constraint's representability as a Vespa sparse filter
 * token, used by the constraint-validator to detect silent-drop bugs at
 * compile time.
 *
 *  - `hard_filterable`     — the attribute has a `case` branch in
 *                            {@link constraintToSparseFilterTokens}; placing
 *                            this constraint in the hard bundle will produce
 *                            registered Vespa filter tokens (provided the
 *                            operator/value combination is supported).
 *  - `soft_promotable`     — the attribute has an entry in
 *                            {@link SOFT_PROMOTION_TOKEN_SPEC}; placing this
 *                            constraint in the soft bundle CAN produce a
 *                            Vespa filter token (if confidence and
 *                            mapping_version gates pass).
 *  - `unknown_attribute`   — the attribute appears in NEITHER set; the
 *                            compile path will silently drop it. This is a
 *                            planner / extractor bug — UNLESS the caller
 *                            recognises the attribute as a ranking-only
 *                            SOFT_CONSTRAINT_ATTRIBUTE (the validator
 *                            consults that set explicitly).
 */
export type ConstraintRepresentability = 'hard_filterable' | 'soft_promotable' | 'unknown_attribute';
/**
 * Returns the {@link ConstraintRepresentability} classification for a single
 * constraint attribute. Used by the constraint-validator.
 *
 * Pure function: no I/O, no shared state. Safe to call from compile-time
 * audits and inside cooperative-abort loops.
 */
export declare function classifyConstraintRepresentability(attribute: string): ConstraintRepresentability;
export {};
//# sourceMappingURL=constraint-to-sparse-filter-tokens.d.ts.map