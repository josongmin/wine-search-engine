import type { QueryRoute } from './query-route.js';

/**
 * ExecutionRetrievalMode — the effective retrieval mode for engine execution.
 *
 * Uses the same string values as RetrievalMode to allow direct cast/validation.
 * Separated into its own type to make the engine execution boundary explicit.
 */
export type ExecutionRetrievalMode =
  | 'entity_lookup'
  | 'entity_resolution'
  | 'attribute_search'
  | 'constraint_filter'
  | 'producer_browse'
  | 'region_browse'
  | 'compare_candidates'
  | 'recommendation'
  | 'similar_items'
  | 'no_match_detection';

/**
 * ExecutionBudget — resource constraints for a single query execution.
 *
 * Derived from the retrieval mode and API overrides.
 */
export interface ExecutionBudget {
  /** Maximum number of candidates to retrieve from the index. */
  readonly maxCandidates: number;

  /** Whether to enable precision reranking for this query. */
  readonly enablePrecisionRerank: boolean;
}

/**
 * ProvenancePolicy — what evidence/sealing is required for this execution.
 *
 * Derived from the planner's admission_context.
 * Consumed by the AdmissionGate to enforce boundary sealing.
 */
export interface ProvenancePolicy {
  /** True if identity seal is required (entity/comparison/mixed routes). */
  readonly requireIdentitySeal: boolean;

  /** True if constraint evidence is required (hard constraints present). */
  readonly requireConstraintEvidence: boolean;

  /** True if anchor evidence is required (mixed route with anchors). */
  readonly requireAnchorEvidence: boolean;
}

/**
 * EngineExecutionContract — the effective execution contract for the engine.
 *
 * Produced by the ExecutionCompiler from a planner snapshot + optional API overrides.
 * This is the single source of truth for how the engine executes the query.
 *
 * Downstream consumers (resolver, scorer, abstention layer) read only from
 * this contract and never re-derive routing or mode decisions.
 */
export interface EngineExecutionContract {
  /** Effective routing target, after override resolution. */
  readonly effectiveRoute: QueryRoute;

  /** Effective retrieval mode, after override resolution. */
  readonly effectiveRetrievalMode: ExecutionRetrievalMode;

  /**
   * Source of the route decision.
   * - 'planner' — used the planner's suggestedRoute
   * - 'api_override' — caller explicitly specified a route override
   *
   * NOTE: This field is computed by ExecutionCompiler but not yet consumed by any production
   * code path. Wiring is deferred. Do NOT read this field until the consuming component is implemented.
   * Note: retrievalModeSource in ResponseBuildParams is derived independently from apiOverrideMode,
   * not from this field.
   */
  readonly routeSource: 'planner' | 'api_override';

  /**
   * Resource budget for this execution.
   *
   * NOTE: This field is computed by ExecutionCompiler but not yet consumed by any production
   * code path. Wiring is deferred. Do NOT read this field until the consuming component is implemented.
   */
  readonly budget: ExecutionBudget;

  /**
   * Provenance policy derived from the admission_context.
   *
   * NOTE: This field is computed by ExecutionCompiler but not yet consumed by any production
   * code path. Wiring is deferred. Do NOT read this field until the consuming component is implemented.
   */
  readonly provenancePolicy: ProvenancePolicy;
}
