import type { QueryUnderstandingSnapshot } from './query-understanding-snapshot.js';
import type { EngineExecutionContract } from './engine-execution-contract.js';

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
}
