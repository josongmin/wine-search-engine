import type { CompiledWineQuery } from '../model/compiled-wine-query.js';
import type {
  EngineExecutionContract,
  ExecutionBudget,
  ExecutionRetrievalMode,
  ProvenancePolicy,
} from '../model/engine-execution-contract.js';
import type { QueryPlanV2 } from '../model/query-plan.js';
import { planV2ToUnderstandingSnapshot as toQueryUnderstandingSnapshot } from '../model/query-plan.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';

/**
 * Input to the ExecutionCompiler.
 */
export interface ExecutionCompilerInput {
  /** The V2 query plan produced by the Planner. */
  readonly plan: QueryPlanV2;

  /**
   * Optional API-level route override from the caller.
   * When set, this takes precedence over the planner's suggestedRoute.
   */
  readonly apiRouteOverride?: 'entity' | 'hybrid' | 'mixed' | undefined;

  /**
   * Optional override for the maximum number of candidates to retrieve.
   * When set, overrides the mode-default maxCandidates in the ExecutionBudget.
   */
  readonly maxCandidatesOverride?: number | undefined;
}

/**
 * Default execution budgets keyed by retrieval mode.
 *
 * These reflect the resource requirements and quality trade-offs for each mode:
 * - Entity lookups are cheap and don't need reranking.
 * - Browse modes fetch moderate sets without reranking.
 * - Comparison, recommendation, and entity_resolution need precision reranking.
 * - Constraint-only and no_match modes are lean.
 */
const DEFAULT_BUDGETS: Record<ExecutionRetrievalMode, ExecutionBudget> = {
  entity_lookup:      { maxCandidates: 10,  enablePrecisionRerank: false },
  entity_resolution:  { maxCandidates: 20,  enablePrecisionRerank: true  },
  attribute_search:   { maxCandidates: 50,  enablePrecisionRerank: true  },
  constraint_filter:  { maxCandidates: 50,  enablePrecisionRerank: false },
  producer_browse:    { maxCandidates: 30,  enablePrecisionRerank: false },
  region_browse:      { maxCandidates: 30,  enablePrecisionRerank: false },
  compare_candidates: { maxCandidates: 20,  enablePrecisionRerank: true  },
  recommendation:     { maxCandidates: 20,  enablePrecisionRerank: true  },
  similar_items:      { maxCandidates: 20,  enablePrecisionRerank: false },
  no_match_detection: { maxCandidates: 5,   enablePrecisionRerank: false },
} as const;

/**
 * Retrieval modes that force the effective route to 'hybrid' regardless of
 * planner suggestion or API override.
 *
 * These modes imply a set-based retrieval strategy that always runs on
 * the hybrid route, even when the query has an entity anchor.
 */
const HYBRID_FORCED_MODES = new Set<ExecutionRetrievalMode>([
  'producer_browse',
  'region_browse',
  'compare_candidates',
  'recommendation',
]);

function normalizeLegacyRetrievalMode(rawMode: string): ExecutionRetrievalMode | undefined {
  switch (rawMode) {
    case 'semantic_hybrid':
    case 'hybrid_search':
      return 'attribute_search';
    default:
      return undefined;
  }
}

/**
 * ExecutionCompiler — converts a QueryPlanV2 into a CompiledWineQuery.
 *
 * Responsibilities:
 * 1. Extract the QueryUnderstandingSnapshot from the plan (pure planner understanding).
 * 2. Resolve the effective route: API override → special-mode forcing → planner suggestion.
 * 3. Map RetrievalMode → ExecutionRetrievalMode (1:1 same string values).
 * 4. Build ExecutionBudget from mode defaults + optional override.
 * 5. Build ProvenancePolicy from admission_context.
 * 6. Produce a CompiledWineQuery combining snapshot + execution contract.
 *
 * This replaces the scattered route/mode decision logic previously spread
 * across search-usecase-route-resolution.ts.
 */
export class ExecutionCompiler {
  /**
   * Compiles a QueryPlanV2 into a CompiledWineQuery.
   *
   * @param input - The plan and optional API overrides.
   * @returns An immutable CompiledWineQuery ready for engine execution.
   */
  compile(input: ExecutionCompilerInput): CompiledWineQuery {
    const { plan, apiRouteOverride, maxCandidatesOverride } = input;

    // 1. Build QueryUnderstandingSnapshot from plan.
    const query = toQueryUnderstandingSnapshot(plan);

    // 2. Map RetrievalMode → ExecutionRetrievalMode (1:1 same string values).
    // Guard: if the incoming mode is not a recognised ExecutionRetrievalMode
    // (e.g. legacy V1 strings like 'semantic_hybrid' or 'hybrid_search' coming
    // through the V1→V2 shim), fall back to 'attribute_search' so the compiler
    // never crashes on an unknown mode.
    const rawMode = plan.suggestedRetrievalMode as string;
    const aliasedMode = normalizeLegacyRetrievalMode(rawMode);
    const effectiveRetrievalMode: ExecutionRetrievalMode =
      (rawMode in DEFAULT_BUDGETS)
        ? (rawMode as ExecutionRetrievalMode)
        : aliasedMode ?? 'attribute_search';

    if (!(rawMode in DEFAULT_BUDGETS) && aliasedMode === undefined) {
      bootstrapLogger.warn(
        { rawMode, query: plan.rawQuery },
        '[ExecutionCompiler] Unknown retrievalMode; falling back to attribute_search defaults',
      );
    }

    // 3. Determine effective route + route source.
    //    Priority: API override > special-mode forcing > planner suggestion.
    let effectiveRoute: 'entity' | 'hybrid' | 'mixed';
    let routeSource: 'planner' | 'api_override';

    if (apiRouteOverride !== undefined) {
      // Caller explicitly specified a route — highest priority.
      effectiveRoute = apiRouteOverride;
      routeSource = 'api_override';
    } else if (HYBRID_FORCED_MODES.has(effectiveRetrievalMode)) {
      // Certain modes always execute on the hybrid route.
      effectiveRoute = 'hybrid';
      routeSource = 'planner';
      if (effectiveRoute !== plan.suggestedRoute) {
        bootstrapLogger.debug(
          { suggestedRoute: plan.suggestedRoute, effectiveRoute, retrievalMode: plan.suggestedRetrievalMode },
          '[ExecutionCompiler] HYBRID_FORCED_MODES override: planner suggested route was overridden',
        );
      }
    } else {
      // Use the planner's suggestion.
      effectiveRoute = plan.suggestedRoute;
      routeSource = 'planner';
    }

    // 4. Build ExecutionBudget from mode defaults + optional override.
    const modeDefaultBudget = DEFAULT_BUDGETS[effectiveRetrievalMode];
    const budget: ExecutionBudget = {
      maxCandidates:
        maxCandidatesOverride ?? modeDefaultBudget.maxCandidates,
      enablePrecisionRerank: modeDefaultBudget.enablePrecisionRerank,
    };

    // 5. Build ProvenancePolicy from admission_context.
    const provenancePolicy: ProvenancePolicy = {
      requireIdentitySeal:
        plan.admission_context?.requires_identity_seal ?? false,
      requireConstraintEvidence:
        plan.admission_context?.requires_constraint_evidence ?? false,
      requireAnchorEvidence:
        plan.admission_context?.requires_anchor_evidence ?? false,
    };

    // 6. Assemble EngineExecutionContract.
    const execution: EngineExecutionContract = {
      effectiveRoute,
      effectiveRetrievalMode,
      routeSource,
      budget,
      provenancePolicy,
    };

    return { query, execution };
  }
}
