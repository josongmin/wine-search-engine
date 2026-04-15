import type { QueryUnderstandingSnapshot } from './query-understanding-snapshot.js';
import type { EngineExecutionContract } from './engine-execution-contract.js';
import type { PolicyDecisionRecord } from './policy-decision-record.js';
import type { ConstraintGraph } from './constraint-graph.js';

/**
 * CompiledWineQuery — the complete compiled query ready for engine execution.
 *
 * Combines the planner's understanding of the query (QueryUnderstandingSnapshot)
 * with the resolved execution contract (EngineExecutionContract).
 *
 * Produced by the ExecutionCompiler; consumed by route-specific use cases.
 *
 * This is the V2 replacement for passing QueryPlanV1 directly into execution.
 */
export interface CompiledWineQuery {
  /** The planner's interpretation of the query (pure understanding, no execution decisions). */
  readonly query: QueryUnderstandingSnapshot;

  /** The resolved execution contract (route, mode, budget, provenance policy). */
  readonly execution: EngineExecutionContract;

  /**
   * Planner policy trace — only populated when `enablePlannerTrace = true` in
   * PlannerContext (i.e. options.explain=true on the search request).
   * Carried here so the post-route phase can attach it to the response without
   * needing to thread QueryPlanV2 separately through the pipeline.
   */
  readonly plannerTrace?: readonly PolicyDecisionRecord[] | undefined;

  /**
   * ADR-011 Phase 1b.1: optional passthrough of `QueryPlanV2.constraintGraph`.
   *
   * Populated by the ExecutionCompiler when the planner emitted a graph
   * (feature flag `CONSTRAINT_GRAPH_EMIT`). Consumers that have migrated to
   * graph-aware logic (currently: provenance-closure) prefer this field;
   * legacy readers ignore it and continue reading `query.constraints`.
   *
   * Absent when `CONSTRAINT_GRAPH_EMIT=false` or when the planner produced
   * no atoms — rollback is a runtime flag flip, not a code change.
   */
  readonly constraintGraph?: ConstraintGraph | undefined;
}
