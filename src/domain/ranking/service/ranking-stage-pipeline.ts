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
import type { FunnelMetrics, RankingFunnelTrace, RankingStageTrace } from '../model/ranking-stage.js';
import type { RankerRuntimeSignal } from '../model/ranking-runtime-signal.js';
import type { RankingOutput } from '../port/ranker.port.js';
import type { Ranker } from './ranker.js';
import type { RankingPolicyPort, PolicyContext } from '../port/ranking-policy.port.js';
import { computeFunnelMetrics } from './funnel-metrics.js';

/**
 * Options for constructing a {@link RankingStagePipeline}.
 */
export interface RankingStagePipelineOptions {
  /**
   * Optional policy hook (T5.5a).
   * When provided, the policy_apply stage calls policy.apply() and may
   * reorder or truncate results. When absent, the stage is a no-op identity.
   */
  readonly policy?: RankingPolicyPort;
}

/**
 * E3-U1: RankingStagePipeline is the **authoritative outer seam** for all
 * ranking execution. Route-specific callers (search.usecase, hybrid.usecase,
 * batch-search) MUST go through this pipeline — not directly through Ranker.
 *
 * Stage ownership:
 *   Stage A (coarse_prune)   — hard-constraint / integrity gate, delegated to Ranker
 *   Stage B (primary_rank)   — signal aggregation + sort, delegated to Ranker
 *   Stage C (precision_rerank) — cross-encoder/LTR, delegated to Ranker
 *   Stage D (policy_apply)   — policy insertion seam (T5.5a), owned here
 *
 * T5.1: Stage-aware ranking pipeline wrapper.
 *
 * Delegates actual scoring to the existing Ranker but wraps
 * the call with stage boundary instrumentation.
 *
 * Usage:
 *   const pipeline = new RankingStagePipeline(ranker);
 *   const results = await pipeline.rank(input);
 *   const funnelTrace = pipeline.getLastFunnelTrace();
 *
 *   // With policy (T5.5a):
 *   const pipeline = new RankingStagePipeline(ranker, { policy: new DefaultRankingPolicy() });
 */
export class RankingStagePipeline {
  private readonly ranker: Ranker;
  private readonly policy: RankingPolicyPort | undefined;
  private _lastFunnelMetrics: FunnelMetrics | undefined = undefined;
  private _lastFunnelTrace: RankingFunnelTrace | undefined = undefined;
  private _lastRuntimeSignal: RankerRuntimeSignal | undefined = undefined;

  constructor(ranker: Ranker, options: RankingStagePipelineOptions = {}) {
    this.ranker = ranker;
    this.policy = options.policy;
  }

  /**
   * Returns the funnel metrics computed during the most recent rank() call.
   * Satisfies the optional {@link RankingPort.getLastFunnelMetrics} contract.
   */
  getLastFunnelMetrics(): FunnelMetrics | undefined {
    return this._lastFunnelMetrics;
  }

  getLastFunnelTrace(): RankingFunnelTrace | undefined {
    return this._lastFunnelTrace;
  }

  getLastRuntimeSignal(): RankerRuntimeSignal | undefined {
    return this._lastRuntimeSignal;
  }

  async rank(input: RankingInput): Promise<RankingOutput> {
    // Reset cached metrics/trace at the start of every call so that a
    // caller who catches a thrown error and reads getLastFunnelMetrics()
    // does not see stale values from the previous successful request.
    this._lastFunnelMetrics = undefined;
    this._lastFunnelTrace = undefined;
    this._lastRuntimeSignal = undefined;

    const wallStart = Date.now();
    const stageTraces: RankingStageTrace[] = [];

    const inputCount = input.candidates.length;

    // --- Stage A + B + C: delegated to Ranker ---
    // The Ranker internally executes coarse_prune, primary_rank, and
    // optionally precision_rerank. We measure the full ranker call wall-clock
    // and attribute coarse_prune separately using the metadata it returns.
    const rankStart = Date.now();
    const { results, metadata: rankingMetadata } = await this.ranker.rank(input);
    const rankLatencyMs = Date.now() - rankStart;

    // Cache the runtime signal so callers can retrieve it via getLastRuntimeSignal().
    this._lastRuntimeSignal = rankingMetadata.runtimeSignal;

    // Retrieve the authoritative coarse prune summary produced during rank().
    const pruneSummary = rankingMetadata.coarsePruneSummary;
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
    const precisionRerankExecuted = rankingMetadata.rerankExecuted;
    const rerankGateReason = rankingMetadata.rerankGateReason;
    // T5.6: Retrieve the pre-rerank top-5 snapshot for rerankChangedTopK metric.
    const preRerankTop5 = rankingMetadata.preRerankTop5;
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
        ...(rerankGateReason !== undefined ? { rerankGateReason } : {}),
      },
    });

    // --- Stage D: Policy apply (T5.5a) ---
    const policyStart = Date.now();
    let finalResults: readonly RankedResult[] = results;
    let policyApplied = false;

    if (this.policy !== undefined) {
      const policyContext: PolicyContext = {
        queryClass: input.queryPlan.queryClass,
        // compiled-first: use compiled execution contract when available (E3-U1)
        effectiveRoute: input.compiled?.execution.effectiveRoute ?? input.queryPlan.route,
      };
      const policyOutput = this.policy.apply(results, policyContext);
      // policyApplied = true only when the policy actually changed something:
      // either the result count differs, or any entity in the same position changed.
      const changed =
        policyOutput.length !== results.length ||
        policyOutput.some((r, i) => r.entityId !== results[i]?.entityId);
      if (changed) {
        finalResults = policyOutput;
        policyApplied = true;
      }
    }

    const policyLatencyMs = Date.now() - policyStart;

    stageTraces.push({
      stage: 'policy_apply',
      inputCount: results.length,
      outputCount: finalResults.length,
      latencyMs: policyLatencyMs,
      notes: {
        status: policyApplied ? 'applied' : 'identity_no_policy_configured',
      },
    });

    // Wall-clock total is the authoritative latency. Stage latencies are
    // best-effort and their sum may undercount inter-stage overhead.
    const totalLatencyMs = Date.now() - wallStart;

    // T5.6: Build the partial trace (without metrics) so we can pass it to computeFunnelMetrics.
    const partialTrace: RankingFunnelTrace = {
      stages: stageTraces,
      totalLatencyMs,
      precisionRerankExecuted,
      policyApplied,
    };

    // T5.6: Compute aggregate funnel metrics and attach to the trace.
    const metrics = computeFunnelMetrics(partialTrace, finalResults, preRerankTop5);

    // Cache metrics so callers can retrieve them via getLastFunnelMetrics().
    this._lastFunnelMetrics = metrics;

    this._lastFunnelTrace = {
      ...partialTrace,
      metrics,
    };

    // The pipeline re-packages the inner ranker's metadata alongside its own
    // policy-applied results so that callers get a consistent RankingOutput.
    // funnelMetrics is bundled into metadata so concurrent requests cannot
    // overwrite each other via the legacy getLastFunnelMetrics() instance
    // state — callers should prefer reading metadata.funnelMetrics directly.
    return {
      results: finalResults,
      metadata: { ...rankingMetadata, funnelMetrics: metrics },
    };
  }
}
