import type { EvalResult } from '../model/eval-result.js';

/**
 * Filter criteria for retrieving evaluation results.
 */
export interface EvalResultFilter {
  /** Only return results produced on or after this timestamp. */
  readonly since?: Date;

  /** Filter by decision snapshot ID (to compare across pipeline versions). */
  readonly snapshotId?: string;
}

/**
 * Port for persisting and retrieving evaluation results, per RFC-009 §5.
 *
 * Infrastructure adapters may store results in a time-series database
 * or append-only log for historical comparison and regression detection.
 */
export interface EvalResultStore {
  /**
   * Persists a single evaluation result.
   *
   * @param result - The evaluation result to save.
   */
  saveResult(result: EvalResult): Promise<void>;

  /**
   * Retrieves evaluation results matching the given filter criteria.
   *
   * @param filter - Optional filter to narrow the returned results.
   * @returns Matching evaluation results.
   */
  getResults(filter?: EvalResultFilter): Promise<readonly EvalResult[]>;
}
