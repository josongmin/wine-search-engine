import {
  buildBatchSearchRunner as buildBatchSearchRunnerImpl,
  type BatchSearchRunner,
  BATCH_SEARCH_MAX_BATCH_SIZE,
} from '../application/search/batch-search-runner.js';
import type { SearchExecutorPort } from '../application/search/port/search-executor.port.js';

export type { BatchSearchRunner };
export { BATCH_SEARCH_MAX_BATCH_SIZE };

/**
 * Eval / fixture-only batch search wiring. Not part of the production
 * `Container` — no live HTTP route after catalog 5.x cutover.
 */
export function buildBatchSearchRunner(searchExecutor: SearchExecutorPort): BatchSearchRunner {
  return buildBatchSearchRunnerImpl(searchExecutor);
}
