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
import type { ScoreDriftRecord } from '../model/score-decomposition.js';

/**
 * E1-T4: Typed reranking decision contract.
 *
 * Replaces the previous `rerankGateReason: string | undefined` with a
 * structured record that carries the full rerank audit trail:
 *   - whether reranking ran
 *   - why it was skipped if it didn't
 *   - which model ran if it did
 *   - how many candidates entered and exited the reranker
 *   - how many were blocked by the safety envelope
 *
 * `decision` is the single typed outcome surface for rerank audit consumers.
 */
export type RerankDecisionCode =
  | 'applied'
  | 'no_model_for_query_class'
  | 'empty_candidates'
  | 'feature_dimension_mismatch'
  | 'gate_blocked';

export interface RerankDecision {
  /** Whether the reranker was actually applied. */
  readonly applied: boolean;
  /**
   * Outcome code:
   *   - `applied`                    — rerank executed normally
   *   - `no_model_for_query_class`   — no LTR model registered for this query class
   *   - `empty_candidates`           — result list was empty before rerank
   *   - `feature_dimension_mismatch` — weight vector length ≠ LTR_MODEL_FEATURE_DIMENSION
   *   - `gate_blocked`               — rerank gate policy suppressed reranking
   *                                    (e.g. has_anchor, too_few_candidates)
   */
  readonly decision: RerankDecisionCode;
  /**
   * Human-readable gate reason string from the rerank gate evaluator.
   * Present for `gate_blocked`; may be present for other outcomes when the
   * gate ran but did not block (e.g. 'has_anchor' — gate passed, rerank ran).
   */
  readonly reason?: string | undefined;
  /** LTR / cross-encoder model ID when `applied === true`. */
  readonly modelId?: string | undefined;
  /** Candidate count entering the reranker. */
  readonly inputCount?: number | undefined;
  /** Candidate count exiting the reranker (after safety filtering). */
  readonly outputCount?: number | undefined;
  /** Candidates blocked by the safety envelope (rerank-safety.ts). */
  readonly blockedCandidateCount?: number | undefined;
  /**
   * E5-T6: Score drift record — LTR vs heuristic ordering drift.
   * Present when LTR was applied and scoreDriftRecord was computed.
   */
  readonly scoreDriftRecord?: ScoreDriftRecord | undefined;
}

/**
 * Metadata produced alongside ranked results during a single rank() call.
 * Replaces the previous mutable getter pattern on the Ranker class.
 */
export interface RankingMetadata {
  /** Coarse prune stage summary (hard constraint / integrity failures). */
  readonly coarsePruneSummary: CoarsePruneStageSummary | undefined;
  /** Whether precision reranking (cross-encoder or LTR) was executed. */
  readonly rerankExecuted: boolean;
  /**
   * E1-T4: Typed reranking decision — replaces `rerankGateReason: string`.
   * Carries the full audit trail: outcome code, gate reason, model, counts.
   * `rerankGateReason` is retained as a deprecated accessor pointing at
   * `rerankDecision.reason` for backward compatibility during migration.
   *
   * @deprecated Use `rerankDecision.reason` instead.
   */
  readonly rerankGateReason: string | undefined;
  /** E1-T4: Typed reranking decision (structured replacement for rerankGateReason). */
  readonly rerankDecision?: RerankDecision | undefined;
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

  /**
   * E5-T6: Score drift record — LTR vs heuristic ordering drift for this query.
   *
   * Present when LTR reranking was executed (rerankExecuted=true and LTR model
   * was applied). Absent for cross-encoder-only reranks or when no reranking ran.
   *
   * @deprecated Access via `rerankDecision.scoreDriftRecord` instead.
   * Retained here for backward compatibility with existing callers.
   */
  readonly scoreDriftRecord?: ScoreDriftRecord | undefined;
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
