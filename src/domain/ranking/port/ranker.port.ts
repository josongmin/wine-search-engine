/**
 * Domain-layer port for the ranking service.
 *
 * Abstracts the concrete {@link Ranker} and the stage-aware
 * {@link RankingStagePipeline} behind a single `rank()` contract so that
 * domain services such as {@link MixedSolver} can depend on the port rather
 * than a concrete implementation.
 */

import type { RankingInput } from '../model/ranking-input.js';
import type { RankedResult } from '../model/ranked-result.js';
import type { RankerRuntimeSignal } from '../model/ranking-runtime-signal.js';
import type { FunnelMetrics } from '../model/ranking-stage.js';

export interface RankerPort {
  rank(input: RankingInput): Promise<readonly RankedResult[]>;
  /**
   * Returns the runtime signal from the most recent rank() call.
   * Includes degradation info when the reranker failed or was skipped.
   */
  getLastRuntimeSignal(): RankerRuntimeSignal | undefined;
  getLastFunnelMetrics?(): FunnelMetrics | undefined;
}
