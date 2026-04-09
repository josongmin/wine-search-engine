/**
 * Dynamic top-K selector.
 *
 * Epic-16 / T16-5 foundation: pick per-channel retrieval widths from
 * the query difficulty label and the latency budget. Pure function,
 * no I/O. All tier thresholds and caps are named constants annotated
 * with the calibration intent. The tiers are deterministic priors;
 * they will be replaced with sweep-calibrated values later.
 */

import type { QueryDifficulty } from './query-difficulty-estimator.js';

export interface TopKSelection {
  readonly sparseTopK: number;
  readonly denseTopK: number;
  readonly anchorTopK: number;
  readonly latencyBudgetMs: number;
}

export interface TopKInput {
  readonly difficulty: QueryDifficulty;
  readonly latencyBudgetMs: number;
  readonly hasAnchor: boolean;
}

// --- Tier thresholds ---
// Budget boundaries used to classify the caller's latency budget into
// tiers. Chosen to match the fast/balanced/deep lanes the HTTP layer
// advertises; they are priors, not measured P95s.
const BUDGET_SMALL_MAX_MS = 300;
const BUDGET_MEDIUM_MAX_MS = 700;

// --- Tier widths ---
// Easy-tier widths: minimal recall — either the anchor is strong or
// the query is a short clean lookup. Wider pools do not help precision.
const EASY_SPARSE_TOP_K = 50;
const EASY_DENSE_TOP_K = 20;
const EASY_ANCHOR_TOP_K = 10;

// Medium-tier widths: balanced recall for the typical browse query.
const MEDIUM_SPARSE_TOP_K = 200;
const MEDIUM_DENSE_TOP_K = 100;
const MEDIUM_ANCHOR_TOP_K = 50;

// Hard-tier widths: maximum recall for long, negated, or mixed-language
// queries where the long tail matters.
const HARD_SPARSE_TOP_K = 500;
const HARD_DENSE_TOP_K = 300;
const HARD_ANCHOR_TOP_K = 100;

// --- Sane caps ---
// Absolute ceilings. Even if a future difficulty/budget combo asks for
// more, we refuse to exceed these — they reflect the practical limits
// of the downstream fusion/reranker stages without blowing the budget.
const MAX_SPARSE_TOP_K = 1000;
const MAX_DENSE_TOP_K = 600;
const MAX_ANCHOR_TOP_K = 200;

// When the requested budget is below the smallest tier, the selector
// returns the easy-tier widths but still honours the caller's budget.
// This constant documents the minimum coherent budget.
const MIN_LATENCY_BUDGET_MS = 50;

interface Tier {
  readonly sparse: number;
  readonly dense: number;
  readonly anchor: number;
}

const EASY_TIER: Tier = {
  sparse: EASY_SPARSE_TOP_K,
  dense: EASY_DENSE_TOP_K,
  anchor: EASY_ANCHOR_TOP_K,
};

const MEDIUM_TIER: Tier = {
  sparse: MEDIUM_SPARSE_TOP_K,
  dense: MEDIUM_DENSE_TOP_K,
  anchor: MEDIUM_ANCHOR_TOP_K,
};

const HARD_TIER: Tier = {
  sparse: HARD_SPARSE_TOP_K,
  dense: HARD_DENSE_TOP_K,
  anchor: HARD_ANCHOR_TOP_K,
};

function pickTier(
  difficulty: QueryDifficulty,
  latencyBudgetMs: number,
): Tier {
  // The effective tier is the MIN of the difficulty tier and the
  // budget tier — we never pay the recall cost of a harder tier when
  // the caller only gave us a small budget, and we never over-spend
  // on an easy query just because the budget was generous.
  const difficultyTier =
    difficulty === 'easy'
      ? EASY_TIER
      : difficulty === 'medium'
        ? MEDIUM_TIER
        : HARD_TIER;

  const budgetTier =
    latencyBudgetMs <= BUDGET_SMALL_MAX_MS
      ? EASY_TIER
      : latencyBudgetMs <= BUDGET_MEDIUM_MAX_MS
        ? MEDIUM_TIER
        : HARD_TIER;

  return {
    sparse: Math.min(difficultyTier.sparse, budgetTier.sparse),
    dense: Math.min(difficultyTier.dense, budgetTier.dense),
    anchor: Math.min(difficultyTier.anchor, budgetTier.anchor),
  };
}

/**
 * Select per-channel top-K widths for the given difficulty and budget.
 *
 * Rules:
 *   - Difficulty and budget each pick a tier; the effective tier is
 *     the element-wise minimum (never over-recall beyond either).
 *   - If !hasAnchor, anchorTopK is forced to 0.
 *   - All widths are capped at sane absolute ceilings.
 *   - Latency budget is clamped to {@link MIN_LATENCY_BUDGET_MS}.
 */
export function selectTopK(input: TopKInput): TopKSelection {
  const latencyBudgetMs = Math.max(
    MIN_LATENCY_BUDGET_MS,
    Math.floor(input.latencyBudgetMs),
  );

  const tier = pickTier(input.difficulty, latencyBudgetMs);

  const sparseTopK = Math.min(MAX_SPARSE_TOP_K, tier.sparse);
  const denseTopK = Math.min(MAX_DENSE_TOP_K, tier.dense);
  const anchorTopK = input.hasAnchor
    ? Math.min(MAX_ANCHOR_TOP_K, tier.anchor)
    : 0;

  return {
    sparseTopK,
    denseTopK,
    anchorTopK,
    latencyBudgetMs,
  };
}
