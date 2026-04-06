/**
 * T5.1: Stage-aware ranking pipeline.
 *
 * Wraps the existing Ranker with explicit stage seams:
 *   Stage A (coarse_prune): hard-constraint fail → removed early
 *   Stage B (primary_rank): signal aggregation + sort
 *   Stage C (precision_rerank): cross-encoder/LTR (via existing Ranker)
 *   Stage D (policy_apply): policy insertion point seam (T5.5a)
 *
 * This file ONLY adds the stage boundary contract. Scoring behavior,
 * rerank weights, and policy logic are unchanged per T5.1 Must-not-change.
 *
 * NOTE on totalLatencyMs: the value is measured as wall-clock time spanning
 * the full pipeline execution (not sum-of-parts). Stage-level latencies are
 * best-effort attributions; their sum may undercount overhead between stages.
 * Wall-clock is the authoritative total.
 */

import type { RankedResult } from '../model/ranked-result.js';
import type { RankingInput } from '../model/ranking-input.js';
import type { RankingFunnelTrace, RankingStageTrace } from '../model/ranking-stage.js';
import type { Ranker } from './ranker.js';

/**
 * RankingFunnelResult — output of the stage-aware pipeline.
 * Extends the existing RankedResult[] with a funnel trace.
 */
export interface RankingFunnelResult {
  readonly results: readonly RankedResult[];
  readonly funnelTrace: RankingFunnelTrace;
}

/**
 * T5.1: Stage-aware ranking pipeline wrapper.
 *
 * Delegates actual scoring to the existing Ranker but wraps
 * the call with stage boundary instrumentation.
 *
 * Usage:
 *   const pipeline = new RankingStagePipeline(ranker);
 *   const { results, funnelTrace } = await pipeline.rank(input);
 */
export class RankingStagePipeline {
  constructor(private readonly ranker: Ranker) {}

  async rank(input: RankingInput): Promise<RankingFunnelResult> {
    const wallStart = Date.now();
    const stageTraces: RankingStageTrace[] = [];

    const inputCount = input.candidates.length;

    // --- Stage A + B + C: delegated to Ranker ---
    // The Ranker internally executes coarse_prune, primary_rank, and
    // optionally precision_rerank. We measure the full ranker call wall-clock
    // and attribute coarse_prune separately using the summary it exposes.
    const rankStart = Date.now();
    const results = await this.ranker.rank(input);
    const rankLatencyMs = Date.now() - rankStart;

    // Retrieve the authoritative coarse prune summary produced during rank().
    const pruneSummary = this.ranker.getLastCoarsePruneSummary();
    const retainedCount = pruneSummary?.retainedCount ?? results.length;

    // --- Stage A: Coarse prune ---
    stageTraces.push({
      stage: 'coarse_prune',
      inputCount,
      outputCount: retainedCount,
      latencyMs: 0, // prune is embedded in ranker call; latency attributed to primary_rank
      ...(pruneSummary !== undefined
        ? {
            notes: {
              prunedCount: pruneSummary.prunedCount,
              hardConstraintFailCount: pruneSummary.hardConstraintFailCount,
              entityIntegrityFailCount: pruneSummary.entityIntegrityFailCount,
            },
          }
        : { notes: { status: 'summary_unavailable' } }),
    });

    // --- Stage B: Primary rank ---
    stageTraces.push({
      stage: 'primary_rank',
      inputCount: retainedCount,
      outputCount: results.length,
      latencyMs: rankLatencyMs,
    });

    // --- Stage C: Precision rerank (always emitted; indicates whether it ran) ---
    // Use the authoritative flag from the Ranker rather than a score-order heuristic.
    // The heuristic is unreliable: blended scores can remain in descending order
    // even after reranking if the blend weight is low.
    const precisionRerankExecuted = this.ranker.getLastRerankExecuted();
    stageTraces.push({
      stage: 'precision_rerank',
      inputCount: results.length,
      outputCount: results.length,
      latencyMs: 0, // bundled with primary_rank until T5.4 separates the timing
      notes: {
        executed: precisionRerankExecuted,
        status: precisionRerankExecuted
          ? 'executed_latency_bundled_with_primary_rank'
          : 'skipped',
      },
    });

    // --- Stage D: Policy apply seam (T5.5a) ---
    stageTraces.push({
      stage: 'policy_apply',
      inputCount: results.length,
      outputCount: results.length,
      latencyMs: 0,
      notes: { status: 'identity_seam_t5_5a_will_populate' },
    });

    // Wall-clock total is the authoritative latency. Stage latencies are
    // best-effort and their sum may undercount inter-stage overhead.
    const totalLatencyMs = Date.now() - wallStart;

    return {
      results,
      funnelTrace: {
        stages: stageTraces,
        totalLatencyMs,
        precisionRerankExecuted,
        policyApplied: false, // T5.5a will set this
      },
    };
  }
}
