import type { StageTimer } from '../../observability/stage-timer.js';

/**
 * Request-scoped execution knobs forwarded from HTTP (or batch parent) into
 * application use cases. Extend deliberately — avoid diverging inline option bags.
 */
export interface RequestExecutionContext {
  readonly abortSignal?: AbortSignal | undefined;
  /**
   * Per-request stage latency tracker. Domain code may call
   * `stageTimer?.start(name)` / `stageTimer?.end(name)` around hot stages
   * (retrieval channels, fusion, ranking, second-phase) so the route
   * handler can read a flat snapshot at the end of the request and emit
   * it through the observability log line. Optional so unit tests and
   * background jobs can omit it without wrapping every call.
   */
  readonly stageTimer?: StageTimer | undefined;
}
