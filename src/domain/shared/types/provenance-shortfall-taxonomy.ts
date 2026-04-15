/**
 * T-E5-02: Unified Provenance Shortfall Taxonomy
 *
 * Canonical taxonomy of machine-readable reason codes emitted across the
 * retrieval / admission / evidence / decision / ranking layers when the
 * engine degrades from its authoritative execution baseline.
 *
 * IMPORTANT: This is the SSoT for degradation reason codes. Any new reason
 * code MUST be added here and imported from this module. Do not create
 * private string literals in consuming modules.
 *
 * Taxonomy layers and their contributing subsystems:
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Layer              │ Prefix                │ Subsystem                  │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ Retrieval          │ retrieval_*            │ hybrid-candidates, sparse  │
 * │ Provenance         │ provenance_shortfall:* │ ranking pipeline, closure  │
 * │ Ranking / Rerank   │ reranker_*, ltr_*      │ ranker (LTR, cross-enc.)   │
 * │ Constraint         │ constraint_*           │ ranking pipeline (relax)   │
 * │ Resolver           │ learned_matcher_*      │ entity resolver            │
 * │ Specialized Route  │ (per-route names)      │ browse/compare candidates  │
 * │ Mixed Route        │ mixed_*                │ mixed-solver               │
 * │ Dense Channel      │ dense_*                │ post-route degradation     │
 * │ Entity Resolver    │ entity_resolver_*      │ hybrid ranking pipeline    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Consuming code can use the union types for type-safe branching on reason
 * codes, or use the prefix-based `classifyShortfallLayer` helper for
 * observability / logging.
 */

// ─── Retrieval layer ────────────────────────────────────────────────────────

/** Retrieval provenance obligation not met (identity, constraint, anchor). */
export type RetrievalProvenanceShortfall =
  | `retrieval_provenance_shortfall:${'identity_evidence' | 'constraint_evidence' | 'anchor_evidence'}`;

/** Dense retrieval channel disabled or unavailable. */
export type DenseChannelShortfall = 'dense_retrieval_disabled';

/** Entity resolver unavailable at retrieval time. */
export type EntityResolverShortfall = 'entity_resolver_unavailable';

// ─── Provenance closure layer (ranking pipeline) ────────────────────────────

/** Provenance closure obligation unmet (detected during ranking). */
export type ProvenanceClosureShortfall =
  | `provenance_shortfall:${'identity_evidence' | 'constraint_evidence' | 'anchor_evidence'}`;

// ─── Ranking / Rerank layer ─────────────────────────────────────────────────

/** Reranker (cross-encoder) execution failures. */
export type RerankerShortfall =
  | 'reranker_timeout'
  | 'reranker_http_error'
  | 'reranker_parse_error'
  | 'reranker_unknown';

/** Rerank score normalization or blend weight failures. */
export type RerankQualityShortfall =
  | 'reranker_score_normalization_failed'
  | 'reranker_blend_weight_invalid';

/** LTR feature dimension mismatch. */
export type LtrShortfall = 'ltr_dimension_mismatch';

// ─── Constraint relaxation layer ────────────────────────────────────────────

/** Constraint relaxation applied during ranking pipeline. */
export type ConstraintRelaxationShortfall =
  | `constraint_relaxed:${string}`
  | `constraint_relaxation_exhausted:${string}`;

// ─── Resolver layer (learned matcher) ───────────────────────────────────────

/** Learned matcher degradation in entity resolver. */
export type LearnedMatcherShortfall =
  | 'learned_matcher_timeout'
  | 'learned_matcher_failed';

// ─── Specialized route layer ────────────────────────────────────────────────

/**
 * Specialized route fallback reasons.
 *
 * NOTE: The canonical values are defined in
 * `src/domain/response/model/specialized-route.ts` as `SPECIALIZED_FALLBACK_REASONS`.
 * This type re-exports them for taxonomy completeness.
 */
export type SpecializedRouteShortfall =
  | 'producer_browse_unavailable'
  | 'producer_browse_fallback'
  | 'region_browse_unavailable'
  | 'region_browse_fallback'
  | 'compare_retriever_unavailable'
  | 'compare_anchor_resolution_failed'
  | 'compare_candidates_fallback';

// ─── Mixed route layer ──────────────────────────────────────────────────────

/**
 * Mixed route fallback reasons.
 *
 * NOTE: The canonical values are defined in
 * `src/domain/mixed/model/mixed-degradation.ts` as `MIXED_FALLBACK_REASONS`.
 * This type re-exports them for taxonomy completeness.
 */
export type MixedRouteShortfall =
  | 'mixed_anchor_resolution_failed'
  | 'mixed_similar_retrieval_unavailable'
  | 'mixed_similar_retrieval_fallback'
  | 'mixed_ranker_unavailable'
  | 'mixed_constraint_overlay_failed';

// ─── Unified union ──────────────────────────────────────────────────────────

/**
 * Union of all known shortfall / degradation reason codes across layers.
 *
 * The `string` tail allows runtime-constructed parametric codes like
 * `constraint_relaxed:grape_primary,region` while still providing
 * autocomplete for the known fixed codes.
 */
export type ProvenanceShortfallCode =
  | RetrievalProvenanceShortfall
  | DenseChannelShortfall
  | EntityResolverShortfall
  | ProvenanceClosureShortfall
  | RerankerShortfall
  | RerankQualityShortfall
  | LtrShortfall
  | ConstraintRelaxationShortfall
  | LearnedMatcherShortfall
  | SpecializedRouteShortfall
  | MixedRouteShortfall;

// ─── Layer classification helper ────────────────────────────────────────────

/**
 * Shortfall layer — for observability grouping (logs, metrics, dashboards).
 */
export type ShortfallLayer =
  | 'retrieval'
  | 'provenance_closure'
  | 'ranking'
  | 'constraint'
  | 'resolver'
  | 'specialized_route'
  | 'mixed_route'
  | 'unknown';

/**
 * Classify a reason code string into its originating layer.
 *
 * Used for metric labels and observability bucketing — not for control flow.
 */
export function classifyShortfallLayer(reasonCode: string): ShortfallLayer {
  if (reasonCode.startsWith('retrieval_provenance_shortfall:')) return 'retrieval';
  if (reasonCode.startsWith('provenance_shortfall:')) return 'provenance_closure';
  if (reasonCode.startsWith('reranker_') || reasonCode.startsWith('ltr_')) return 'ranking';
  if (reasonCode.startsWith('constraint_')) return 'constraint';
  if (reasonCode.startsWith('learned_matcher_') || reasonCode === 'entity_resolver_unavailable') return 'resolver';
  if (reasonCode.startsWith('dense_')) return 'retrieval';
  if (reasonCode.startsWith('mixed_')) return 'mixed_route';
  if (
    reasonCode.startsWith('producer_browse_')
    || reasonCode.startsWith('region_browse_')
    || reasonCode.startsWith('compare_')
  ) {
    return 'specialized_route';
  }
  return 'unknown';
}
