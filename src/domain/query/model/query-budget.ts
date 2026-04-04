/**
 * Resource budget for a single query execution.
 *
 * Constrains latency, candidate count, and reranker fan-out to keep
 * query execution within acceptable limits.
 */
export interface QueryBudget {
  /** Maximum allowed end-to-end latency in milliseconds. */
  readonly maxLatencyMs: number;

  /** Maximum number of candidates to retrieve from the index. */
  readonly maxCandidates: number;

  /** Maximum number of candidates to pass to the reranker. */
  readonly rerankLimit: number;

  /** Optional cap on the number of dense (embedding) retrieval calls. */
  readonly maxDenseCalls?: number | undefined;
}

/** Sensible defaults for production query budgets. */
export const DEFAULT_QUERY_BUDGET: QueryBudget = {
  maxLatencyMs: 450,
  maxCandidates: 200,
  rerankLimit: 50,
} as const;
