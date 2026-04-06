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

import type { EntityId } from '../../shared/types/index.js';
import type { ComponentScores } from './ranked-result.js';

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
 * A candidate entering the coarse pruning stage.
 * Contains only what's needed for fast hard-filter decisions.
 */
export interface CoarsePruneInput {
  readonly entityId: EntityId;
  readonly hardConstraintPass: boolean;
  readonly fusedScore: number;
  /** Reason for pre-filtering (from retrieval phase). */
  readonly filterFailReason?: string;
}

/** Result of coarse pruning for one candidate. */
export interface CoarsePruneResult {
  readonly entityId: EntityId;
  readonly retained: boolean;
  /** Set when retained === false. */
  readonly pruneReason?: CoarsePruneReason;
}

export type CoarsePruneReason =
  | 'hard_constraint_fail'
  | 'filter_pre_fail'
  | 'score_below_floor';

// ---------------------------------------------------------------------------

/**
 * Candidate entering primary ranking stage — after coarse prune.
 * Carries provenance/channel features for channel-aware ranking (T5.3).
 */
export interface PrimaryRankInput {
  readonly entityId: EntityId;
  readonly fusedScore: number;
  readonly componentScores: ComponentScores;
  /**
   * Channel sources that contributed to this candidate.
   * Used for channel-aware weighting in T5.3.
   */
  readonly channels: readonly string[];
  /**
   * Whether the candidate was anchor-conditioned.
   * Elevates anchor signals in primary rank.
   */
  readonly anchorConditioned: boolean;
}

/** Result of primary ranking. */
export interface PrimaryRankResult {
  readonly entityId: EntityId;
  /** Score after primary rank aggregation. */
  readonly primaryScore: number;
  readonly rank: number;
}

// ---------------------------------------------------------------------------

/**
 * Candidate entering selective precision rerank (T5.4).
 * Only top-K from primary rank enter this stage.
 */
export interface PrecisionRerankInput {
  readonly entityId: EntityId;
  readonly primaryScore: number;
  readonly primaryRank: number;
  /** Passage text for cross-encoder or LTR reranking. */
  readonly passageText: string;
}

/** Result of precision rerank. */
export interface PrecisionRerankResult {
  readonly entityId: EntityId;
  readonly rerankScore: number;
  readonly finalRank: number;
}

// ---------------------------------------------------------------------------

/**
 * Candidate entering policy application stage (T5.5a seam).
 * Relevance score is finalized; policy can only adjust, not override relevance.
 */
export interface PolicyApplyInput {
  readonly entityId: EntityId;
  readonly relevanceScore: number;
  readonly rank: number;
  /** Metadata that policy rules may read. */
  readonly policyMetadata?: Readonly<Record<string, unknown>>;
}

/** Result of policy application. */
export interface PolicyApplyResult {
  readonly entityId: EntityId;
  /** Final score after policy adjustments. */
  readonly finalScore: number;
  readonly finalRank: number;
  /** True if policy adjusted the score. */
  readonly policyApplied: boolean;
  readonly policyReason?: string;
}

// ---------------------------------------------------------------------------
// Stage trace
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
}
