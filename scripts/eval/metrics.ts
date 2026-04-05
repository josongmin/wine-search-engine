/**
 * IR & Decision metrics library for the evaluation pipeline.
 *
 * Implements: NDCG@K, MRR@K, Recall@K, Decision Utility (RFC-009 §5.1),
 * AURC, E-AURC, ECE, and scenario-specific metrics.
 *
 * All functions are pure — no I/O.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankedHit {
  readonly entity_id: string;
  readonly score: number;
}

export interface RelevanceMap {
  /** entity_id → grade (0-3). */
  readonly judgments: ReadonlyMap<string, number>;
}

export interface DecisionOutcome {
  readonly decision_status: 'resolved' | 'ambiguous' | 'failed';
  readonly top_entity_id: string | null;
  readonly decision_confidence: number;
}

export interface GroundTruth {
  readonly expected_status: 'resolved' | 'ambiguous' | 'failed';
  readonly expected_entity_id?: string;
  readonly ambiguity_expected: boolean;
  readonly requires_abstain: boolean;
  readonly relevant: RelevanceMap;
}

// ---------------------------------------------------------------------------
// NDCG@K (graded relevance)
// ---------------------------------------------------------------------------

/**
 * Normalised Discounted Cumulative Gain at rank K.
 * Uses the standard formula: gain = 2^grade - 1, discount = 1/log2(rank+1).
 */
export function ndcg(
  ranked: readonly RankedHit[],
  relevance: RelevanceMap,
  k: number,
): number {
  const dcg = ranked.slice(0, k).reduce((sum, hit, i) => {
    const grade = relevance.judgments.get(hit.entity_id) ?? 0;
    return sum + (Math.pow(2, grade) - 1) / Math.log2(i + 2);
  }, 0);

  // Ideal DCG: sort all grades descending
  const allGrades = [...relevance.judgments.values()].sort((a, b) => b - a);
  const ideal = allGrades.slice(0, k).reduce((sum, grade, i) => {
    return sum + (Math.pow(2, grade) - 1) / Math.log2(i + 2);
  }, 0);

  return ideal === 0 ? 0 : dcg / ideal;
}

// ---------------------------------------------------------------------------
// MRR@K (Mean Reciprocal Rank)
// ---------------------------------------------------------------------------

/**
 * Reciprocal rank of the first relevant hit (grade >= minGrade) within top K.
 * Returns 0 if no relevant hit in top K.
 */
export function reciprocalRank(
  ranked: readonly RankedHit[],
  relevance: RelevanceMap,
  k: number,
  minGrade = 1,
): number {
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    const hit = ranked[i]!;
    const grade = relevance.judgments.get(hit.entity_id) ?? 0;
    if (grade >= minGrade) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Recall@K
// ---------------------------------------------------------------------------

/**
 * Fraction of relevant items (grade >= minGrade) that appear in top K results.
 */
export function recall(
  ranked: readonly RankedHit[],
  relevance: RelevanceMap,
  k: number,
  minGrade = 1,
): number {
  const relevant = [...relevance.judgments.entries()].filter(
    ([, g]) => g >= minGrade,
  );
  if (relevant.length === 0) return 1; // vacuously true

  const topK = new Set(ranked.slice(0, k).map((h) => h.entity_id));
  const found = relevant.filter(([id]) => topK.has(id)).length;
  return found / relevant.length;
}

// ---------------------------------------------------------------------------
// Constraint Satisfaction Rate
// ---------------------------------------------------------------------------

export interface ConstraintCheck {
  readonly satisfied: boolean;
  readonly constraint_name: string;
}

/**
 * Fraction of hard constraints satisfied by the top result.
 */
export function constraintSatisfactionRate(
  checks: readonly ConstraintCheck[],
): number {
  if (checks.length === 0) return 1;
  return checks.filter((c) => c.satisfied).length / checks.length;
}

// ---------------------------------------------------------------------------
// Decision Utility (RFC-009 §5.1)
// ---------------------------------------------------------------------------

/** Utility weights — RFC-009 §5.1 SSOT. */
const UTILITY = {
  correct_resolve: 1.0,
  safe_abstain: 0.4,
  useful_clarification: 0.1,
  wrong_resolve: -1.5,
  avoidable_abstain: -0.3,
} as const;

export type DecisionCategory =
  | 'correct_resolve'
  | 'safe_abstain'
  | 'useful_clarification'
  | 'wrong_resolve'
  | 'avoidable_abstain';

/**
 * Classify a single (decision, ground_truth) pair into a decision category.
 */
export function classifyDecision(
  outcome: DecisionOutcome,
  truth: GroundTruth,
): DecisionCategory {
  if (outcome.decision_status === 'resolved') {
    // Check if the resolved entity is correct
    if (truth.expected_entity_id) {
      return outcome.top_entity_id === truth.expected_entity_id
        ? 'correct_resolve'
        : 'wrong_resolve';
    }
    // If ground truth expects ambiguity but system resolved → wrong
    if (truth.ambiguity_expected) return 'wrong_resolve';
    // If relevant entities exist and top entity is in them
    const topGrade = outcome.top_entity_id
      ? (truth.relevant.judgments.get(outcome.top_entity_id) ?? 0)
      : 0;
    return topGrade >= 3 ? 'correct_resolve' : 'wrong_resolve';
  }

  if (outcome.decision_status === 'ambiguous') {
    return truth.ambiguity_expected ? 'safe_abstain' : 'avoidable_abstain';
  }

  // failed
  if (truth.requires_abstain) return 'safe_abstain';
  if (truth.relevant.judgments.size === 0) return 'safe_abstain';
  return 'avoidable_abstain';
}

/**
 * Compute utility score for a single query.
 */
export function queryUtility(
  outcome: DecisionOutcome,
  truth: GroundTruth,
): number {
  const category = classifyDecision(outcome, truth);
  return UTILITY[category];
}

/**
 * Aggregate Decision Utility Score across all queries.
 */
export function decisionUtility(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  if (outcomes.length === 0) return 0;
  let totalUtility = 0;
  for (let i = 0; i < outcomes.length; i++) {
    totalUtility += queryUtility(outcomes[i]!, truths[i]!);
  }
  return totalUtility / outcomes.length;
}

// ---------------------------------------------------------------------------
// Wrong Top-1 Rate (RFC-009 §4.1 — most important metric)
// ---------------------------------------------------------------------------

export function wrongTop1Rate(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  if (outcomes.length === 0) return 0;
  let wrong = 0;
  for (let i = 0; i < outcomes.length; i++) {
    if (classifyDecision(outcomes[i]!, truths[i]!) === 'wrong_resolve') {
      wrong++;
    }
  }
  return wrong / outcomes.length;
}

// ---------------------------------------------------------------------------
// Safe / Avoidable Abstain Rates
// ---------------------------------------------------------------------------

export function safeAbstainRate(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  if (outcomes.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < outcomes.length; i++) {
    if (classifyDecision(outcomes[i]!, truths[i]!) === 'safe_abstain') count++;
  }
  return count / outcomes.length;
}

export function avoidableAbstainRate(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  if (outcomes.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < outcomes.length; i++) {
    if (classifyDecision(outcomes[i]!, truths[i]!) === 'avoidable_abstain') count++;
  }
  return count / outcomes.length;
}

// ---------------------------------------------------------------------------
// AURC / E-AURC (Selective Prediction — RFC-009 §5.3)
// ---------------------------------------------------------------------------

/**
 * Area Under Risk-Coverage Curve.
 *
 * Sorts queries by confidence descending, then sweeps coverage from 0 to 1.
 * At each coverage level, computes risk = P(wrong_resolve | confident enough).
 * Lower AURC = better.
 */
export function aurc(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  if (outcomes.length === 0) return 0;

  // Sort by confidence descending
  const indexed = outcomes.map((o, i) => ({ outcome: o, truth: truths[i]!, idx: i }));
  indexed.sort((a, b) => b.outcome.decision_confidence - a.outcome.decision_confidence);

  let wrongSoFar = 0;
  let area = 0;

  for (let i = 0; i < indexed.length; i++) {
    const { outcome, truth } = indexed[i]!;
    if (classifyDecision(outcome, truth) === 'wrong_resolve') {
      wrongSoFar++;
    }
    const risk = wrongSoFar / (i + 1);
    const stepWidth = 1 / indexed.length;
    area += risk * stepWidth;
  }

  return area;
}

/**
 * Optimal AURC: the theoretical minimum AURC if we could perfectly
 * order queries so all correct ones come before wrong ones.
 */
function optimalAurc(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  const n = outcomes.length;
  if (n === 0) return 0;

  let wrongTotal = 0;
  for (let i = 0; i < n; i++) {
    if (classifyDecision(outcomes[i]!, truths[i]!) === 'wrong_resolve') {
      wrongTotal++;
    }
  }

  // Optimal: all wrong at the end
  const correctCount = n - wrongTotal;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const risk = i < correctCount ? 0 : (i - correctCount + 1) / (i + 1);
    area += risk / n;
  }
  return area;
}

/**
 * Excess AURC = AURC - Optimal AURC.
 * Measures how much worse the calibration is compared to perfect ordering.
 */
export function excessAurc(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  return aurc(outcomes, truths) - optimalAurc(outcomes, truths);
}

// ---------------------------------------------------------------------------
// ECE (Expected Calibration Error — RFC-009 §7)
// ---------------------------------------------------------------------------

/**
 * Expected Calibration Error with equal-width binning.
 * Measures how well decision_confidence matches actual correctness probability.
 * Target: ≤ 0.05.
 */
export function ece(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
  bins = 10,
): number {
  if (outcomes.length === 0) return 0;

  const buckets = Array.from({ length: bins }, () => ({
    totalConf: 0,
    totalCorrect: 0,
    count: 0,
  }));

  for (let i = 0; i < outcomes.length; i++) {
    const conf = outcomes[i]!.decision_confidence;
    const category = classifyDecision(outcomes[i]!, truths[i]!);
    const correct = category === 'correct_resolve' || category === 'safe_abstain' ? 1 : 0;

    const binIdx = Math.min(Math.floor(conf * bins), bins - 1);
    const bucket = buckets[binIdx]!;
    bucket.totalConf += conf;
    bucket.totalCorrect += correct;
    bucket.count++;
  }

  let totalEce = 0;
  for (const bucket of buckets) {
    if (bucket.count === 0) continue;
    const avgConf = bucket.totalConf / bucket.count;
    const avgAcc = bucket.totalCorrect / bucket.count;
    totalEce += (bucket.count / outcomes.length) * Math.abs(avgConf - avgAcc);
  }

  return totalEce;
}

// ---------------------------------------------------------------------------
// Set Retrieval Metrics (Scenarios E, F, G)
// ---------------------------------------------------------------------------

/**
 * Intra-set diversity: 1 - (most common producer ratio).
 * Higher = more diverse results.
 */
export function intraSetDiversity(
  producerCounts: ReadonlyMap<string, number>,
  totalResults: number,
): number {
  if (totalResults === 0) return 0;
  let maxCount = 0;
  for (const count of producerCounts.values()) {
    if (count > maxCount) maxCount = count;
  }
  return 1 - maxCount / totalResults;
}

/**
 * Set coverage: fraction of relevant set that appears in results.
 */
export function setCoverage(
  resultIds: ReadonlySet<string>,
  relevance: RelevanceMap,
  minGrade = 2,
): number {
  const relevant = [...relevance.judgments.entries()].filter(
    ([, g]) => g >= minGrade,
  );
  if (relevant.length === 0) return 1;
  const found = relevant.filter(([id]) => resultIds.has(id)).length;
  return found / relevant.length;
}

// ---------------------------------------------------------------------------
// Aggregate result type
// ---------------------------------------------------------------------------

export interface EvalResult {
  readonly dataset_tier: 'bronze' | 'silver' | 'gate';
  readonly query_count: number;

  // Global metrics
  readonly ndcg_at_10: number;
  readonly mrr_at_10: number;
  readonly recall_at_100: number;
  readonly decision_utility: number;
  readonly wrong_top1_rate: number;
  readonly safe_abstain_rate: number;
  readonly avoidable_abstain_rate: number;

  // Selective prediction
  readonly aurc: number;
  readonly e_aurc: number;

  // Calibration
  readonly ece: number;

  // Scenario slices
  readonly by_scenario: Record<string, ScenarioSlice>;
  readonly by_language: Record<string, ScenarioSlice>;
}

export interface ScenarioSlice {
  readonly query_count: number;
  readonly ndcg_at_10: number;
  readonly mrr_at_10: number;
  readonly wrong_top1_rate: number;
  readonly decision_utility: number;
}
