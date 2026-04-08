/**
 * Domain-layer port for the ranking service.
 *
 * Abstracts the concrete {@link Ranker} and the stage-aware
 * {@link RankingStagePipeline} behind a single `rank()` contract so that
 * domain services such as {@link MixedSolver} can depend on the port rather
 * than a concrete implementation.
 */

import type { RankingInput } from '../model/ranking-input.js';
import type { RankedResult, CoarsePruneStageSummary } from '../model/ranked-result.js';
import type { RankerRuntimeSignal } from '../model/ranking-runtime-signal.js';
import type { FunnelMetrics } from '../model/ranking-stage.js';

/**
 * Metadata produced alongside ranked results during a single rank() call.
 * Replaces the previous mutable getter pattern on the Ranker class.
 */
export interface RankingMetadata {
  /** Coarse prune stage summary (hard constraint / integrity failures). */
  readonly coarsePruneSummary: CoarsePruneStageSummary | undefined;
  /** Whether precision reranking (cross-encoder or LTR) was executed. */
  readonly rerankExecuted: boolean;
  /** Gate decision reason (e.g. 'has_anchor', 'too_few_candidates'). */
  readonly rerankGateReason: string | undefined;
  /** Runtime signal including reranker status and degradation info. */
  readonly runtimeSignal: RankerRuntimeSignal | undefined;
  /** Top-5 entityIds captured after primary sort, before rerank. */
  readonly preRerankTop5: readonly string[];
  /**
   * Funnel metrics computed by RankingStagePipeline. Populated only when the
   * ranker is wrapped in the stage pipeline; undefined for direct Ranker.
   * Returned via metadata (not instance state) so concurrent rank() calls
   * cannot corrupt each other's funnel data.
   */
  readonly funnelMetrics?: FunnelMetrics | undefined;
}

/**
 * Return type for {@link RankerPort.rank} — results plus metadata.
 */
export interface RankingOutput {
  readonly results: readonly RankedResult[];
  readonly metadata: RankingMetadata;
}

export interface RankerPort {
  rank(input: RankingInput): Promise<RankingOutput>;
  getLastFunnelMetrics?(): FunnelMetrics | undefined;
}
