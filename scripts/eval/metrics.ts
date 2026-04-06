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
  readonly entity_type?: string;
  readonly producer?: string;
  readonly region?: string;
  readonly appellation?: string;
  /** Normalized 0–1 or 0–100 from index; eval normalizes for prestige@k. */
  readonly producer_prestige?: number;
  readonly grapes?: readonly string[];
}

export interface RelevanceMap {
  /** entity_id → grade (0-3). */
  readonly judgments: ReadonlyMap<string, number>;
}

export interface DecisionOutcome {
  readonly decision_status: 'resolved' | 'ambiguous' | 'failed';
  readonly top_entity_id: string | null;
  readonly decision_confidence: number;
  readonly execution_mode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
  readonly blocking_eligible?: boolean;
  readonly degradation_reasons?: readonly string[];
  readonly specialized_route_requested?: 'producer_browse' | 'region_browse' | 'compare_candidates' | null;
  readonly specialized_route_executed?: 'producer_browse' | 'region_browse' | 'compare_candidates' | null;
  readonly fallback_applied?: boolean;
  readonly fallback_reason?:
    | 'producer_browse_unavailable'
    | 'producer_browse_fallback'
    | 'region_browse_unavailable'
    | 'region_browse_fallback'
    | 'compare_retriever_unavailable'
    | 'compare_anchor_resolution_failed'
    | 'compare_candidates_fallback'
    | null;
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
/**
 * Expected Calibration Error with equal-width binning.
 *
 * Only includes resolved decisions (abstentions are excluded —
 * ECE measures calibration of the resolve/not-resolve decision,
 * not the abstain decision which has its own metrics).
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
    const outcome = outcomes[i]!;
    // ECE only for resolved decisions — abstain/failed are excluded
    if (outcome.decision_status !== 'resolved') continue;

    const conf = outcome.decision_confidence;
    const category = classifyDecision(outcome, truths[i]!);
    const correct = category === 'correct_resolve' ? 1 : 0;

    const binIdx = Math.min(Math.floor(conf * bins), bins - 1);
    const bucket = buckets[binIdx]!;
    bucket.totalConf += conf;
    bucket.totalCorrect += correct;
    bucket.count++;
  }

  const resolvedCount = buckets.reduce((s, b) => s + b.count, 0);
  if (resolvedCount === 0) return 0;

  let totalEce = 0;
  for (const bucket of buckets) {
    if (bucket.count === 0) continue;
    const avgConf = bucket.totalConf / bucket.count;
    const avgAcc = bucket.totalCorrect / bucket.count;
    totalEce += (bucket.count / resolvedCount) * Math.abs(avgConf - avgAcc);
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
// Mode-specific metrics (Epic 11)
// ---------------------------------------------------------------------------

/** Supported retrieval modes for mode-specific evaluation. */
export type RetrievalMode =
  | 'entity_lookup'
  | 'entity_resolution'
  | 'attribute_search'
  | 'constraint_filter'
  | 'producer_browse'
  | 'region_browse'
  | 'compare_candidates'
  | 'recommendation'
  | 'similar_items'
  | 'no_match_detection';

/**
 * Per-mode metrics slice — specializes ScenarioSlice for retrieval modes.
 * Includes mode-specific metrics (diversity, coverage, etc).
 */
export interface ModeMetrics {
  readonly retrieval_mode: RetrievalMode;
  readonly query_count: number;

  // Standard IR metrics
  readonly ndcg_at_10: number;
  readonly mrr_at_10: number;
  readonly recall_at_10: number;
  readonly wrong_top1_rate: number;
  readonly decision_utility: number;

  // Mode-specific optional metrics (added when mode-specific data available)
  diversity_score?: number;
  anchor_preservation_score?: number;
  producer_variety?: number;
  /** Distinct browse line keys (producer|grape|app) / min(n,10) in top 10. */
  browse_line_diversity_at_10?: number;
  /** Distinct primary grapes / count in top 10 (region browse). */
  grape_variety_at_10?: number;
  /** Mean normalized producer prestige mass in top-10 slots (missing = 0). */
  prestige_mean_at_10?: number;
  set_coverage?: number;
  seed_exclusion_rate?: number;
  attribute_coverage?: number;
}

export interface SpecializedFallbackRate {
  readonly requested_count: number;
  readonly fallback_rate: number | null;
}

export interface SpecializedFallbackMetrics {
  readonly fallback_rate: {
    readonly producer_browse: SpecializedFallbackRate;
    readonly region_browse: SpecializedFallbackRate;
    readonly compare_candidates: SpecializedFallbackRate;
  };
  readonly fallback_reason_histogram?: Readonly<Record<string, number>>;
}

/**
 * Per-entity-type metrics — confusion matrix for entity resolution.
 * Tracks whether the engine resolved to the correct entity type.
 */
export interface EntityTypeMetrics {
  readonly target_type: EntityTargetType;
  readonly query_count: number;
  readonly correct_type_rate: number;
  readonly confusion_matrix: Record<EntityTargetType, number>;
}

export type EntityTargetType = 'wine' | 'producer' | 'region' | 'unknown';

/**
 * Intra-set diversity score for set retrieval modes (producer_browse, region_browse).
 * Higher = more diverse results.
 *
 * Currently placeholder; in production would measure producer variety,
 * price spread, grape variety, etc.
 */
export function setDiversityScore(candidates: readonly RankedHit[]): number {
  if (candidates.length <= 1) {
    return 0;
  }

  const labels = candidates
    .map((candidate) => candidate.producer ?? candidate.region)
    .filter((label): label is string => typeof label === 'string' && label.length > 0);

  if (labels.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return intraSetDiversity(counts, labels.length);
}

/**
 * Anchor preservation score for similar_items mode.
 * Measures whether anchor entity or similar items are in top results.
 *
 * Currently placeholder; would require anchor entity in query context.
 */
export function anchorPreservationScore(
  anchor: string,
  results: readonly RankedHit[],
): number {
  if (results.length === 0) {
    return 0;
  }

  return results.some((result) => result.entity_id === anchor) ? 1 : 0;
}

/**
 * Producer variety in result set (for browse modes).
 * Returns fraction of distinct producers in top K results.
 *
 * Placeholder: requires producer metadata in results.
 */
export function producerVariety(results: readonly RankedHit[]): number {
  return producerVarietyAtK(results, 10);
}

/** Distinct producers in top-K / min(K, n). */
export function producerVarietyAtK(results: readonly RankedHit[], k: number): number {
  if (results.length === 0 || k <= 0) {
    return 0;
  }
  const slice = results.slice(0, k);
  const producers = slice
    .map((result) => result.producer)
    .filter((producer): producer is string => typeof producer === 'string' && producer.length > 0);

  if (producers.length === 0) {
    return 0;
  }

  return new Set(producers).size / producers.length;
}

function primaryGrape(h: RankedHit): string {
  const g = h.grapes?.[0];
  return typeof g === 'string' ? g.trim().toLowerCase() : '';
}

function browseLineKey(h: RankedHit): string {
  const p = (h.producer ?? '').trim().toLowerCase();
  const g = primaryGrape(h);
  const a = (h.appellation ?? h.region ?? '').trim().toLowerCase();
  if (p.length > 0 && g.length > 0 && a.length > 0) {
    return `${p}|${g}|${a}`;
  }
  if (p.length > 0 && g.length > 0) {
    return `${p}|${g}`;
  }
  return p.length > 0 ? p : h.entity_id;
}

/**
 * Fraction of distinct structured product lines in top-K (aligns with browse-diversity.ts intent).
 */
export function browseLineDiversityAtK(ranked: readonly RankedHit[], k: number): number {
  const slice = ranked.slice(0, k);
  if (slice.length === 0) {
    return 0;
  }
  const keys = new Set(slice.map((h) => browseLineKey(h)));
  return keys.size / slice.length;
}

/** Distinct primary grapes / number of hits with grape metadata in top-K. */
export function grapeVarietyAtK(ranked: readonly RankedHit[], k: number): number {
  const slice = ranked.slice(0, k);
  const grapes = slice.map(primaryGrape).filter((g) => g.length > 0);
  if (grapes.length === 0) {
    return 0;
  }
  return new Set(grapes).size / grapes.length;
}

function normalizePrestige(p: number | undefined): number {
  if (p === undefined || !Number.isFinite(p)) {
    return 0;
  }
  return p <= 1 ? p : p / 100;
}

/**
 * Mean prestige score in top-K slots (missing prestige counts as 0), divide by K.
 */
export function prestigeMeanAtK(ranked: readonly RankedHit[], k: number): number {
  if (k <= 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < k; i++) {
    sum += normalizePrestige(ranked[i]?.producer_prestige);
  }
  return sum / k;
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
  readonly recall_at_3: number;
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
  readonly by_execution_mode?: Record<EvalExecutionModeBucket, ScenarioSlice>;
  readonly by_blocking_eligible?: Record<EvalBlockingEligibleBucket, ScenarioSlice>;
  readonly degradation_reason_histogram?: Record<string, number>;
  readonly execution_mode_x_blocking_eligible?: Record<
    EvalExecutionModeBucket,
    Partial<Record<EvalBlockingEligibleBucket, EvalCountShareBucket>>
  >;
  readonly release_report?: EvalReleaseReport;

  // Epic 11: Mode-specific slices
  by_mode?: Record<RetrievalMode, ModeMetrics>;
  specialized_fallback?: SpecializedFallbackMetrics;

  // Epic 11: Entity target type slices
  by_target_type?: Record<EntityTargetType, EntityTypeMetrics>;

  // Epic 11: Release gate verdict
  release_gate_verdict?: {
    readonly passed: boolean;
    readonly failures: readonly string[];
    readonly advisories?: readonly string[];
  };

  metric_policy?: {
    readonly blocking_metrics: readonly string[];
    readonly advisory_metrics: readonly string[];
  };

  non_blocking_metrics?: readonly string[];

  // T5.7: Optional statistical diagnostics for offline eval comparisons.
  diagnostics?: {
    readonly per_query_metrics?: {
      readonly ndcg_at_10: readonly number[];
      readonly mrr_at_10: readonly number[];
      readonly recall_at_3: readonly number[];
      readonly recall_at_100: readonly number[];
      readonly decision_utility: readonly number[];
      readonly non_wrong_top1_rate: readonly number[];
    };
  };

  // T5.7: Optional baseline delta + significance summary.
  baseline_comparison?: {
    readonly baseline_path: string;
    readonly deltas: {
      readonly ndcg_at_10: number;
      readonly mrr_at_10: number;
      readonly recall_at_3: number;
      readonly recall_at_100: number;
      readonly decision_utility: number;
      readonly wrong_top1_rate: number;
      readonly execution_mode_mix?: Partial<Record<EvalExecutionModeBucket, number>>;
      readonly blocking_eligible_share?: Partial<Record<EvalBlockingEligibleBucket, number>>;
      readonly degradation_reason_distribution?: Record<string, {
        readonly count_delta: number;
        readonly percentage_point_delta: number;
      }>;
    };
    readonly highlights?: readonly string[];
    readonly significance?: {
      readonly corrected_alpha: number;
      readonly significant_metrics: readonly string[];
      readonly metrics: Record<string, {
        readonly p_value: number;
        readonly ci_95: readonly [number, number];
        readonly mean_diff: number;
        readonly significant: boolean;
      }>;
    };
    readonly significance_skipped_reason?: string;
  };
}

export interface ScenarioSlice {
  readonly query_count: number;
  readonly ndcg_at_10: number;
  readonly mrr_at_10: number;
  readonly wrong_top1_rate: number;
  readonly decision_utility: number;
}

export type EvalExecutionModeBucket =
  | 'authoritative'
  | 'degraded'
  | 'heuristic'
  | 'advisory'
  | 'unknown';

export type EvalBlockingEligibleBucket =
  | 'blocking_eligible'
  | 'non_blocking_eligible'
  | 'unknown';

export interface EvalCountShareBucket {
  readonly query_count: number;
  readonly share: number;
}

export interface EvalReleaseReportReasonSummary {
  readonly reason: string;
  readonly query_count: number;
  readonly share: number;
}

export interface EvalReleaseReport {
  readonly degraded_query_share: EvalCountShareBucket;
  readonly heuristic_query_share: EvalCountShareBucket;
  readonly blocking_vs_advisory_summary: {
    readonly blocking_eligible: EvalCountShareBucket;
    readonly non_blocking_eligible: EvalCountShareBucket;
    readonly unknown: EvalCountShareBucket;
    readonly advisory_queries: EvalCountShareBucket;
  };
  readonly top_degradation_reasons: readonly EvalReleaseReportReasonSummary[];
  readonly specialized_fallback_summary?: SpecializedFallbackMetrics;
}
