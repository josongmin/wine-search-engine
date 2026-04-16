/**
 * T5.1: Ranking Stage Contract
 *
 * Defines the four-stage ranking funnel:
 *   Stage A: Coarse pruning      — remove hard-fail candidates early
 *   Stage B: Channel-aware rank  — primary ranking with provenance features
 *   Stage C: Selective rerank    — precision rerank (cross-encoder / LTR)
 *   Stage D: Policy insertion    — relevance → policy boundary seam
 *
 * Each stage has explicit input/output types so they can be tested,
 * observed, and replaced independently.
 */

// ---------------------------------------------------------------------------
// Stage enum
// ---------------------------------------------------------------------------

export type RankingStage = 'coarse_prune' | 'primary_rank' | 'precision_rerank' | 'policy_apply';

export const RANKING_STAGES = [
  'coarse_prune',
  'primary_rank',
  'precision_rerank',
  'policy_apply',
] as const satisfies readonly RankingStage[];

// ---------------------------------------------------------------------------
// Per-stage input/output contracts
// ---------------------------------------------------------------------------

/**
 * Observability trace emitted by each stage, attached to the final result.
 * Used for stage-level diagnostics and counterfactual eval (T5.6, T5.7).
 */
export interface RankingStageTrace {
  /** Which stage this trace is from. */
  readonly stage: RankingStage;

  /** How many candidates entered this stage. */
  readonly inputCount: number;

  /** How many candidates passed (were retained / promoted). */
  readonly outputCount: number;

  /** Latency of this stage in milliseconds. */
  readonly latencyMs: number;

  /**
   * Stage-specific notes (prune reason counts, rerank threshold, policy rule IDs, etc.).
   * Intentionally untyped for extensibility — structured in observability schema.
   */
  readonly notes?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Funnel-level aggregate metrics (T5.6)
// ---------------------------------------------------------------------------

/**
 * Aggregate metrics computed across the full ranking funnel for one query.
 * Attached to {@link RankingFunnelTrace} after all stages complete.
 * Used for stage-level explainability and offline quality monitoring.
 */
export interface FunnelMetrics {
  /** Fraction of candidates that passed coarse prune. */
  readonly coarsePrunePassRate: number;
  /** Whether precision rerank actually changed top-5 order. */
  readonly rerankChangedTopK: boolean;
  /** Mean final score of retained candidates. */
  readonly meanFinalScore: number;
  /** Score gap between rank-1 and rank-2 (confidence signal). Null when fewer than 2 results. */
  readonly scoreGapRank1Rank2: number | null;
  /** Number of unique producers in final result set. */
  readonly producerDiversity: number;
}

/**
 * Full ranking funnel trace for one query execution.
 */
export interface RankingFunnelTrace {
  readonly stages: readonly RankingStageTrace[];
  /** Total latency across all stages in ms. */
  readonly totalLatencyMs: number;
  /** Whether precision rerank was actually executed. */
  readonly precisionRerankExecuted: boolean;
  /** Whether policy adjustments were applied. */
  readonly policyApplied: boolean;
  /** Aggregate funnel metrics computed after all stages complete (T5.6). */
  readonly metrics?: FunnelMetrics | undefined;
}
