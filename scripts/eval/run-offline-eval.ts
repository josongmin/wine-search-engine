#!/usr/bin/env tsx
/**
 * Offline Evaluation Runner: Reads golden queries, runs them through the
 * search pipeline, and computes all metrics.
 *
 * Outputs:
 * - Global metrics (NDCG, MRR, Recall, Decision Utility, AURC, ECE)
 * - Scenario-specific slices (entity_resolve, ranking_quality, set_retrieval, no_match)
 * - Language slices
 * - Release gate pass/fail verdict
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/eval/run-offline-eval.ts
 *   npx tsx --env-file=.env scripts/eval/run-offline-eval.ts --tier gate --output data/eval-results.json
 *   npx tsx scripts/eval/run-offline-eval.ts --verify-splits   # run split integrity first (RFC-017 §2.5)
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseNdjson } from '../etl/ndjson.js';
import type { GoldenQuery } from '../etl/types.js';
import {
  ndcg,
  reciprocalRank,
  recall,
  classifyDecision,
  queryUtility,
  wrongTop1Rate,
  safeAbstainRate,
  avoidableAbstainRate,
  aurc,
  excessAurc,
  ece,
  setDiversityScore,
  anchorPreservationScore,
  producerVariety,
  setCoverage,
  browseLineDiversityAtK,
  grapeVarietyAtK,
  prestigeMeanAtK,
  type RankedHit,
  type DecisionOutcome,
  type GroundTruth,
  type EvalResult,
  type ScenarioSlice,
  type RetrievalMode,
  type ModeMetrics,
  type EntityTargetType,
  type EntityTypeMetrics,
  type SpecializedFallbackMetrics,
  type EvalExecutionModeBucket,
  type EvalBlockingEligibleBucket,
  type EvalCountShareBucket,
  type EvalReleaseReport,
} from './metrics.js';
import { multipleComparison, type MultiComparisonResult } from './significance.js';
import {
  buildEvalMetricPolicySummary,
  createEvalMetricViolation,
  splitEvalMetricViolations,
} from './eval-metric-policy.js';
import {
  inferEntityTargetType as inferEntityTargetTypeFromQuery,
  inferResolvedEntityType,
} from './entity-type.js';
import { verifyDefaultGoldenSplits } from './split-integrity.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INPUT = 'data/golden-queries-bronze.jsonl';
const DEFAULT_OUTPUT = 'data/eval-results.json';

/** Release gate thresholds (RFC-017 §3.2). */
const RELEASE_GATES = {
  wrong_top1_rate_max: 0.02,
  decision_utility_min_delta: -0.05,
  ndcg_at_10_min_delta: -0.03,
  recall_at_100_min: 0.90,
  aurc_max_delta: 0.01,
  entity_resolve_wrong_top1_max: 0.03,
  set_retrieval_recall_at_10_min: 0.60,
  no_match_false_resolve_max: 0.05,
} as const;

/**
 * Release gates for retrieval modes (Epic 11, advisory in phase 1).
 * Optional keys (handled when present): `prestige_mean_at_10_min` — opt-in when eval hits
 * include stable `producer_prestige`; otherwise omit to avoid noisy advisories.
 */
const MODE_RELEASE_GATES: Record<RetrievalMode, Record<string, number>> = {
  entity_lookup: {
    wrong_top1_rate_max: 0.02,
    ndcg_at_10_min: 0.50,
  },
  entity_resolution: {
    wrong_top1_rate_max: 0.05,
    ndcg_at_10_min: 0.40,
  },
  attribute_search: {
    ndcg_at_10_min: 0.45,
    recall_at_10_min: 0.60,
  },
  constraint_filter: {
    recall_at_10_min: 0.70,
  },
  producer_browse: {
    set_coverage_min: 0.50,
    producer_variety_min: 0.60,
    /** Distinct browse-line keys in top-10 / 10 (see `browseLineDiversityAtK`). */
    browse_line_diversity_at_10_min: 0.35,
  },
  region_browse: {
    set_coverage_min: 0.55,
    diversity_min: 0.60,
    browse_line_diversity_at_10_min: 0.35,
    /** Distinct primary grapes / hits with grape metadata in top-10. */
    grape_variety_at_10_min: 0.25,
  },
  compare_candidates: {
    attribute_coverage_min: 0.70,
    ndcg_at_10_min: 0.50,
  },
  recommendation: {
    ndcg_at_10_min: 0.45,
  },
  similar_items: {
    anchor_preservation_min: 0.60,
    seed_exclusion_min: 0.95,
  },
  no_match_detection: {
    wrong_top1_rate_max: 0.05,
  },
} as const;

const ALL_RETRIEVAL_MODES: RetrievalMode[] = [
  'entity_lookup',
  'entity_resolution',
  'attribute_search',
  'constraint_filter',
  'producer_browse',
  'region_browse',
  'compare_candidates',
  'recommendation',
  'similar_items',
  'no_match_detection',
];

const SPECIALIZED_FALLBACK_REASONS = new Set([
  'producer_browse_unavailable',
  'producer_browse_fallback',
  'region_browse_unavailable',
  'region_browse_fallback',
  'compare_retriever_unavailable',
  'compare_anchor_resolution_failed',
  'compare_candidates_fallback',
]);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  input: string;
  output: string;
  tier: 'bronze' | 'silver' | 'gate';
  baselineReport?: string;
  /** When true, run `verify-splits` logic before any search (fail-fast on leakage). */
  verifySplits: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    tier: 'bronze',
    baselineReport: undefined,
    verifySplits: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i] ?? DEFAULT_INPUT;
    else if (a === '--output' || a === '-o') out.output = argv[++i] ?? DEFAULT_OUTPUT;
    else if (a === '--baseline-report') out.baselineReport = argv[++i];
    else if (a === '--tier') {
      const t = argv[++i];
      if (t === 'bronze' || t === 'silver' || t === 'gate') out.tier = t;
    } else if (a === '--verify-splits') {
      out.verifySplits = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Search execution (calls the running engine)
// ---------------------------------------------------------------------------

function evalSearchTimeoutMs(): number {
  const raw = process.env['EVAL_SEARCH_TIMEOUT_MS'];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1000) return 60_000;
  return n;
}

function evalSearchConcurrency(): number {
  const raw = process.env['EVAL_SEARCH_CONCURRENCY'];
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 12;
  return Math.min(64, n);
}

function shouldSkipEmbeddingValidation(): boolean {
  return process.env['EVAL_SKIP_EMBEDDING_VALIDATION'] === 'true';
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

interface SearchResult {
  readonly ranked: RankedHit[];
  readonly decision: DecisionOutcome;
}

export interface OfflineEvalCaseResult {
  readonly query: GoldenQuery;
  readonly ranked: RankedHit[];
  readonly decision: DecisionOutcome;
  readonly truth: GroundTruth;
}

export interface OfflinePerQueryMetrics {
  readonly ndcg_at_10: readonly number[];
  readonly mrr_at_10: readonly number[];
  readonly recall_at_3: readonly number[];
  readonly recall_at_100: readonly number[];
  readonly decision_utility: readonly number[];
  readonly non_wrong_top1_rate: readonly number[];
}

interface EvalSearchRequestBody {
  readonly query: string;
  readonly options: {
    readonly mode: 'auto' | 'entity' | 'hybrid' | 'mixed';
    readonly explain: false;
    readonly clarification: false;
  };
  readonly retrieval_mode?: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
}

export function buildEvalSearchRequestBody(query: GoldenQuery): EvalSearchRequestBody {
  const mode = query.retrieval_mode === 'similar_items' ? 'mixed' : 'hybrid';

  return {
    query: query.query,
    options: {
      mode,
      explain: false as const,
      clarification: false as const,
    },
    // Golden-query retrieval modes are internal evaluation labels, not a
    // 1:1 match for the public API's top-level route override. The public
    // eval harness executes the closest route family the search endpoint can
    // express: similar-items rows use `mixed`, everything else uses the
    // ranked-search family (`hybrid`).
    retrieval_mode: mode,
  };
}

async function executeSearch(goldenQuery: GoldenQuery, timeoutMs: number): Promise<SearchResult> {
  // Call the running search API
  const apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';
  const requestBody = buildEvalSearchRequestBody(goldenQuery);

  try {
    const response = await fetch(`${apiUrl}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return {
        ranked: [],
        decision: {
          decision_status: 'failed',
          top_entity_id: null,
          decision_confidence: 0,
        },
      };
    }

    // Parse response — robust to both camelCase (internal/direct) and
    // snake_case (HTTP API with preSerialization hook) field naming.
    // Root cause: if the snake-case hook is misconfigured or the eval script
    // is pointed at a different endpoint, entity_id silently becomes '' for
    // every hit, collapsing Recall@100 to near-zero.
    const raw = (await response.json()) as Record<string, unknown>;

    // Accept both engine_decision (snake) and engineDecision (camel)
    const engineDecision = (raw['engine_decision'] ?? raw['engineDecision'] ?? {}) as Record<string, unknown>;
    const meta = (raw['meta'] ?? {}) as Record<string, unknown>;
    const rawResults = (raw['results'] ?? []) as Record<string, unknown>[];

    const ranked: RankedHit[] = rawResults.map((r) => {
      const entity = (r['entity'] ?? {}) as Record<string, unknown>;
      // Accept both entity_id (snake) and entityId (camel)
      const entityId = (entity['entity_id'] ?? entity['entityId'] ?? '') as string;
      const score = (r['relevance_score'] ?? r['relevanceScore'] ?? 0) as number;
      const entityType = entity['type'];
      const producer = entity['producer'];
      const region = entity['region'];
      const appellation = entity['appellation'];
      const prestigeRaw = entity['producer_prestige'] ?? entity['producerPrestige'];
      const grapes = entity['grapes'];
      const producer_prestige =
        typeof prestigeRaw === 'number' && Number.isFinite(prestigeRaw) ? prestigeRaw : undefined;
      return {
        entity_id: String(entityId),
        score,
        ...(typeof entityType === 'string' ? { entity_type: entityType } : {}),
        ...(typeof producer === 'string' ? { producer } : {}),
        ...(typeof region === 'string' ? { region } : {}),
        ...(typeof appellation === 'string' ? { appellation } : {}),
        ...(producer_prestige !== undefined ? { producer_prestige } : {}),
        ...(Array.isArray(grapes)
          ? { grapes: grapes.filter((value): value is string => typeof value === 'string') }
          : {}),
      };
    });

    const decisionStatus = (engineDecision['decision_status'] ?? engineDecision['decisionStatus'] ?? 'failed') as string;
    const decisionConfidence = (engineDecision['decision_confidence'] ?? engineDecision['decisionConfidence'] ?? 0) as number;
    const executionMode = engineDecision['execution_mode'] ?? engineDecision['executionMode'];
    const blockingEligible = engineDecision['blocking_eligible'] ?? engineDecision['blockingEligible'];
    const degradationReasons = engineDecision['degradation_reasons'] ?? engineDecision['degradationReasons'];
    const specializedRouteRequested =
      meta['specialized_route_requested'] ?? meta['specializedRouteRequested'];
    const specializedRouteExecuted =
      meta['specialized_route_executed'] ?? meta['specializedRouteExecuted'];
    const fallbackApplied = meta['fallback_applied'] ?? meta['fallbackApplied'];
    const fallbackReason = meta['fallback_reason'] ?? meta['fallbackReason'];

    const decision: DecisionOutcome = {
      decision_status: decisionStatus as 'resolved' | 'ambiguous' | 'failed',
      top_entity_id: ranked[0]?.entity_id ?? null,
      decision_confidence: decisionConfidence,
      ...(typeof executionMode === 'string'
        ? {
            execution_mode: executionMode as
              | 'authoritative'
              | 'degraded'
              | 'heuristic'
              | 'advisory',
          }
        : {}),
      ...(typeof blockingEligible === 'boolean' ? { blocking_eligible: blockingEligible } : {}),
      ...(Array.isArray(degradationReasons)
        ? {
            degradation_reasons: degradationReasons.filter(
              (value): value is string => typeof value === 'string',
            ),
          }
        : {}),
      ...(typeof specializedRouteRequested === 'string' || specializedRouteRequested === null
        ? {
            specialized_route_requested: specializedRouteRequested as
              | 'producer_browse'
              | 'region_browse'
              | 'compare_candidates'
              | null,
          }
        : {}),
      ...(typeof specializedRouteExecuted === 'string' || specializedRouteExecuted === null
        ? {
            specialized_route_executed: specializedRouteExecuted as
              | 'producer_browse'
              | 'region_browse'
              | 'compare_candidates'
              | null,
          }
        : {}),
      ...(typeof fallbackApplied === 'boolean' ? { fallback_applied: fallbackApplied } : {}),
      ...(typeof fallbackReason === 'string' || fallbackReason === null
        ? {
            fallback_reason: fallbackReason as
              | 'producer_browse_unavailable'
              | 'producer_browse_fallback'
              | 'region_browse_unavailable'
              | 'region_browse_fallback'
              | 'compare_retriever_unavailable'
              | 'compare_anchor_resolution_failed'
              | 'compare_candidates_fallback'
              | null,
          }
        : {}),
    };

    return { ranked, decision };
  } catch {
    return {
      ranked: [],
      decision: {
        decision_status: 'failed',
        top_entity_id: null,
        decision_confidence: 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Query → GroundTruth conversion
// ---------------------------------------------------------------------------

function queryToGroundTruth(q: GoldenQuery): GroundTruth {
  const judgments = new Map<string, number>();
  for (const j of q.retrieval_labels.relevant) {
    judgments.set(j.entity_id, j.grade);
  }

  return {
    expected_status: q.decision_labels.expected_decision_status,
    expected_entity_id: q.decision_labels.expected_entity_id,
    ambiguity_expected: q.decision_labels.ambiguity_expected,
    requires_abstain: q.decision_labels.requires_abstain,
    relevant: { judgments },
  };
}

export function buildOfflinePerQueryMetrics(
  results: readonly OfflineEvalCaseResult[],
): OfflinePerQueryMetrics {
  return {
    ndcg_at_10: results.map((r) => ndcg(r.ranked, r.truth.relevant, 10)),
    mrr_at_10: results.map((r) => reciprocalRank(r.ranked, r.truth.relevant, 10)),
    recall_at_3: results.map((r) => recall(r.ranked, r.truth.relevant, 3)),
    recall_at_100: results.map((r) => recall(r.ranked, r.truth.relevant, 100)),
    decision_utility: results.map((r) => queryUtility(r.decision, r.truth)),
    non_wrong_top1_rate: results.map((r) =>
      classifyDecision(r.decision, r.truth) === 'wrong_resolve' ? 0 : 1),
  };
}

interface StoredOfflinePerQueryMetrics {
  readonly ndcg_at_10?: readonly number[];
  readonly mrr_at_10?: readonly number[];
  readonly recall_at_3?: readonly number[];
  readonly recall_at_100?: readonly number[];
  readonly decision_utility?: readonly number[];
  readonly non_wrong_top1_rate?: readonly number[];
}

interface StoredOfflineEvalReport {
  readonly query_count?: number;
  readonly ndcg_at_10?: number;
  readonly mrr_at_10?: number;
  readonly recall_at_3?: number;
  readonly recall_at_100?: number;
  readonly decision_utility?: number;
  readonly wrong_top1_rate?: number;
  readonly by_execution_mode?: Partial<Record<EvalExecutionModeBucket, { readonly query_count?: number }>>;
  readonly by_blocking_eligible?: Partial<Record<EvalBlockingEligibleBucket, { readonly query_count?: number }>>;
  readonly degradation_reason_histogram?: Record<string, number>;
  readonly diagnostics?: {
    readonly per_query_metrics?: StoredOfflinePerQueryMetrics;
  };
}

export interface OfflineBaselineComparison {
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
}

function toExecutionModeBucket(decision: DecisionOutcome): EvalExecutionModeBucket {
  switch (decision.execution_mode) {
    case 'authoritative':
    case 'degraded':
    case 'heuristic':
    case 'advisory':
      return decision.execution_mode;
    default:
      return 'unknown';
  }
}

function toBlockingEligibleBucket(decision: DecisionOutcome): EvalBlockingEligibleBucket {
  if (decision.blocking_eligible === true) {
    return 'blocking_eligible';
  }
  if (decision.blocking_eligible === false) {
    return 'non_blocking_eligible';
  }
  return 'unknown';
}

export function computeExecutionModeSlices(
  results: readonly OfflineEvalCaseResult[],
): Record<EvalExecutionModeBucket, ScenarioSlice> {
  const buckets = new Map<EvalExecutionModeBucket, OfflineEvalCaseResult[]>();
  for (const result of results) {
    const bucket = toExecutionModeBucket(result.decision);
    const existing = buckets.get(bucket);
    if (existing) {
      existing.push(result);
    } else {
      buckets.set(bucket, [result]);
    }
  }

  const orderedBuckets: readonly EvalExecutionModeBucket[] = [
    'authoritative',
    'degraded',
    'heuristic',
    'advisory',
    'unknown',
  ];
  return Object.fromEntries(
    orderedBuckets
      .filter((bucket) => (buckets.get(bucket)?.length ?? 0) > 0)
      .map((bucket) => [bucket, computeSlice(buckets.get(bucket) ?? [])]),
  ) as Record<EvalExecutionModeBucket, ScenarioSlice>;
}

export function computeBlockingEligibleSlices(
  results: readonly OfflineEvalCaseResult[],
): Record<EvalBlockingEligibleBucket, ScenarioSlice> {
  const buckets = new Map<EvalBlockingEligibleBucket, OfflineEvalCaseResult[]>();
  for (const result of results) {
    const bucket = toBlockingEligibleBucket(result.decision);
    const existing = buckets.get(bucket);
    if (existing) {
      existing.push(result);
    } else {
      buckets.set(bucket, [result]);
    }
  }

  const orderedBuckets: readonly EvalBlockingEligibleBucket[] = [
    'blocking_eligible',
    'non_blocking_eligible',
    'unknown',
  ];
  return Object.fromEntries(
    orderedBuckets
      .filter((bucket) => (buckets.get(bucket)?.length ?? 0) > 0)
      .map((bucket) => [bucket, computeSlice(buckets.get(bucket) ?? [])]),
  ) as Record<EvalBlockingEligibleBucket, ScenarioSlice>;
}

export function computeDegradationReasonHistogram(
  results: readonly OfflineEvalCaseResult[],
): Record<string, number> {
  const histogram = new Map<string, number>();
  for (const result of results) {
    for (const reason of result.decision.degradation_reasons ?? []) {
      histogram.set(reason, (histogram.get(reason) ?? 0) + 1);
    }
  }
  return Object.fromEntries(
    [...histogram.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function computeExecutionModeBlockingEligibleMatrix(
  results: readonly OfflineEvalCaseResult[],
): Record<EvalExecutionModeBucket, Partial<Record<EvalBlockingEligibleBucket, EvalCountShareBucket>>> {
  const counts = new Map<EvalExecutionModeBucket, Map<EvalBlockingEligibleBucket, number>>();
  for (const result of results) {
    const modeBucket = toExecutionModeBucket(result.decision);
    const blockingBucket = toBlockingEligibleBucket(result.decision);
    const row = counts.get(modeBucket) ?? new Map<EvalBlockingEligibleBucket, number>();
    row.set(blockingBucket, (row.get(blockingBucket) ?? 0) + 1);
    counts.set(modeBucket, row);
  }

  const total = results.length === 0 ? 1 : results.length;
  const orderedModes: readonly EvalExecutionModeBucket[] = [
    'authoritative',
    'degraded',
    'heuristic',
    'advisory',
    'unknown',
  ];
  const orderedBlocking: readonly EvalBlockingEligibleBucket[] = [
    'blocking_eligible',
    'non_blocking_eligible',
    'unknown',
  ];

  return Object.fromEntries(
    orderedModes
      .filter((modeBucket) => counts.has(modeBucket))
      .map((modeBucket) => [
        modeBucket,
        Object.fromEntries(
          orderedBlocking
            .filter((blockingBucket) => (counts.get(modeBucket)?.get(blockingBucket) ?? 0) > 0)
            .map((blockingBucket) => {
              const query_count = counts.get(modeBucket)?.get(blockingBucket) ?? 0;
              return [
                blockingBucket,
                {
                  query_count,
                  share: query_count / total,
                } satisfies EvalCountShareBucket,
              ];
            }),
        ),
      ]),
  ) as Record<EvalExecutionModeBucket, Partial<Record<EvalBlockingEligibleBucket, EvalCountShareBucket>>>;
}

function toSerializableMultiComparison(
  result: MultiComparisonResult,
): OfflineBaselineComparison['significance'] {
  const metrics = Object.fromEntries(
    [...result.raw_results.entries()].map(([name, metric]) => [
      name,
      {
        p_value: metric.p_value,
        ci_95: metric.ci_95,
        mean_diff: metric.mean_diff,
        significant: metric.significant,
      },
    ]),
  );
  return {
    corrected_alpha: result.corrected_alpha,
    significant_metrics: result.significant_metrics,
    metrics,
  };
}

export function buildOfflineBaselineComparison(
  baselinePath: string,
  current: Pick<
    EvalResult,
    | 'ndcg_at_10'
    | 'mrr_at_10'
    | 'recall_at_3'
    | 'recall_at_100'
    | 'decision_utility'
    | 'wrong_top1_rate'
    | 'by_execution_mode'
    | 'by_blocking_eligible'
    | 'degradation_reason_histogram'
  >,
  baseline: StoredOfflineEvalReport,
  currentPerQuery: OfflinePerQueryMetrics,
): OfflineBaselineComparison {
  const baselineNdcg = baseline.ndcg_at_10 ?? 0;
  const baselineMrr = baseline.mrr_at_10 ?? 0;
  const baselineRecallAt3 = baseline.recall_at_3 ?? 0;
  const baselineRecallAt100 = baseline.recall_at_100 ?? 0;
  const baselineDecisionUtility = baseline.decision_utility ?? 0;
  const baselineWrongTop1Rate = baseline.wrong_top1_rate ?? 0;
  const currentQueryCount = Math.max(1, currentPerQuery.ndcg_at_10.length);
  const baselineQueryCount = Math.max(1, baseline.query_count ?? currentQueryCount);
  const baselineExecutionModeCounts = baseline.by_execution_mode;
  const baselineBlockingEligibleCounts = baseline.by_blocking_eligible;
  const baselineDegradationHistogram = baseline.degradation_reason_histogram ?? {};

  function deltaFromCount(
    currentCount: number | undefined,
    baselineCount: number | undefined,
  ): number {
    const currentShare = (currentCount ?? 0) / currentQueryCount;
    const baselineShare = (baselineCount ?? 0) / baselineQueryCount;
    return currentShare - baselineShare;
  }

  const comparison: OfflineBaselineComparison = {
    baseline_path: baselinePath,
    deltas: {
      ndcg_at_10: current.ndcg_at_10 - baselineNdcg,
      mrr_at_10: current.mrr_at_10 - baselineMrr,
      recall_at_3: current.recall_at_3 - baselineRecallAt3,
      recall_at_100: current.recall_at_100 - baselineRecallAt100,
      decision_utility: current.decision_utility - baselineDecisionUtility,
      wrong_top1_rate: current.wrong_top1_rate - baselineWrongTop1Rate,
      ...(current.by_execution_mode !== undefined || baselineExecutionModeCounts !== undefined
        ? {
            execution_mode_mix: {
              authoritative: deltaFromCount(
                current.by_execution_mode?.authoritative?.query_count,
                baselineExecutionModeCounts?.authoritative?.query_count,
              ),
              degraded: deltaFromCount(
                current.by_execution_mode?.degraded?.query_count,
                baselineExecutionModeCounts?.degraded?.query_count,
              ),
              heuristic: deltaFromCount(
                current.by_execution_mode?.heuristic?.query_count,
                baselineExecutionModeCounts?.heuristic?.query_count,
              ),
              advisory: deltaFromCount(
                current.by_execution_mode?.advisory?.query_count,
                baselineExecutionModeCounts?.advisory?.query_count,
              ),
              unknown: deltaFromCount(
                current.by_execution_mode?.unknown?.query_count,
                baselineExecutionModeCounts?.unknown?.query_count,
              ),
            },
          }
        : {}),
      ...(current.by_blocking_eligible !== undefined || baselineBlockingEligibleCounts !== undefined
        ? {
            blocking_eligible_share: {
              blocking_eligible: deltaFromCount(
                current.by_blocking_eligible?.blocking_eligible?.query_count,
                baselineBlockingEligibleCounts?.blocking_eligible?.query_count,
              ),
              non_blocking_eligible: deltaFromCount(
                current.by_blocking_eligible?.non_blocking_eligible?.query_count,
                baselineBlockingEligibleCounts?.non_blocking_eligible?.query_count,
              ),
              unknown: deltaFromCount(
                current.by_blocking_eligible?.unknown?.query_count,
                baselineBlockingEligibleCounts?.unknown?.query_count,
              ),
            },
          }
        : {}),
      ...(
        current.degradation_reason_histogram !== undefined || Object.keys(baselineDegradationHistogram).length > 0
          ? {
              degradation_reason_distribution: Object.fromEntries(
                [...new Set([
                  ...Object.keys(current.degradation_reason_histogram ?? {}),
                  ...Object.keys(baselineDegradationHistogram),
                ])]
                  .sort((left, right) => left.localeCompare(right))
                  .map((reason) => {
                    const currentCount = current.degradation_reason_histogram?.[reason] ?? 0;
                    const baselineCount = baselineDegradationHistogram[reason] ?? 0;
                    return [
                      reason,
                      {
                        count_delta: currentCount - baselineCount,
                        percentage_point_delta:
                          currentCount / currentQueryCount - baselineCount / baselineQueryCount,
                      },
                    ];
                  }),
              ),
            }
          : {}
      ),
    },
  };

  const highlights: string[] = [];
  const degradedDelta = comparison.deltas.execution_mode_mix?.degraded ?? 0;
  if (Math.abs(comparison.deltas.ndcg_at_10) < 0.01 && degradedDelta > 0.05) {
    highlights.push(
      `accuracy stable but degraded share up (${(degradedDelta * 100).toFixed(1)}pp)`,
    );
  }

  const baselinePerQuery = baseline.diagnostics?.per_query_metrics;
  if (baselinePerQuery === undefined) {
    return {
      ...comparison,
      significance_skipped_reason: 'baseline report is missing diagnostics.per_query_metrics',
    };
  }

  const metrics = new Map<string, { baseline: readonly number[]; candidate: readonly number[] }>();
  const pairs: readonly [keyof OfflinePerQueryMetrics, string][] = [
    ['ndcg_at_10', 'ndcg_at_10'],
    ['mrr_at_10', 'mrr_at_10'],
    ['recall_at_3', 'recall_at_3'],
    ['recall_at_100', 'recall_at_100'],
    ['decision_utility', 'decision_utility'],
    ['non_wrong_top1_rate', 'non_wrong_top1_rate'],
  ];

  for (const [key, name] of pairs) {
    const baselineSeries = baselinePerQuery[key];
    const candidateSeries = currentPerQuery[key];
    if (baselineSeries === undefined) {
      return {
        ...comparison,
        significance_skipped_reason: `baseline report is missing diagnostics.per_query_metrics.${key}`,
      };
    }
    if (baselineSeries.length !== candidateSeries.length) {
      return {
        ...comparison,
        significance_skipped_reason:
          `per-query metric length mismatch for ${key}: baseline=${baselineSeries.length} current=${candidateSeries.length}`,
      };
    }
    metrics.set(name, { baseline: baselineSeries, candidate: candidateSeries });
  }

  return {
    ...comparison,
    ...(highlights.length > 0 ? { highlights } : {}),
    significance: toSerializableMultiComparison(multipleComparison(metrics)),
  };
}

export function buildDegradationAwareReleaseReport(
  result: Pick<
    EvalResult,
    | 'query_count'
    | 'by_execution_mode'
    | 'by_blocking_eligible'
    | 'degradation_reason_histogram'
    | 'specialized_fallback'
  >,
): EvalReleaseReport {
  const total = Math.max(1, result.query_count);
  const byExecutionMode = result.by_execution_mode ?? {};
  const byBlockingEligible = result.by_blocking_eligible ?? {};
  const histogram = result.degradation_reason_histogram ?? {};

  function toCountShare(query_count: number | undefined): EvalCountShareBucket {
    const count = query_count ?? 0;
    return {
      query_count: count,
      share: count / total,
    };
  }

  return {
    degraded_query_share: toCountShare(byExecutionMode.degraded?.query_count),
    heuristic_query_share: toCountShare(byExecutionMode.heuristic?.query_count),
    blocking_vs_advisory_summary: {
      blocking_eligible: toCountShare(byBlockingEligible.blocking_eligible?.query_count),
      non_blocking_eligible: toCountShare(byBlockingEligible.non_blocking_eligible?.query_count),
      unknown: toCountShare(byBlockingEligible.unknown?.query_count),
      advisory_queries: toCountShare(byExecutionMode.advisory?.query_count),
    },
    top_degradation_reasons: Object.entries(histogram)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 5)
      .map(([reason, query_count]) => ({
        reason,
        query_count,
        share: query_count / total,
      })),
    ...(result.specialized_fallback !== undefined
      ? { specialized_fallback_summary: result.specialized_fallback }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Compute slice metrics
// ---------------------------------------------------------------------------

function computeSlice(
  results: readonly { ranked: RankedHit[]; decision: DecisionOutcome; truth: GroundTruth }[],
): ScenarioSlice {
  if (results.length === 0) {
    return {
      query_count: 0,
      ndcg_at_10: 0,
      mrr_at_10: 0,
      wrong_top1_rate: 0,
      decision_utility: 0,
    };
  }

  const ndcgValues = results.map((r) => ndcg(r.ranked, r.truth.relevant, 10));
  const mrrValues = results.map((r) => reciprocalRank(r.ranked, r.truth.relevant, 10));
  const decisions = results.map((r) => r.decision);
  const truths = results.map((r) => r.truth);

  return {
    query_count: results.length,
    ndcg_at_10: ndcgValues.reduce((a, b) => a + b, 0) / ndcgValues.length,
    mrr_at_10: mrrValues.reduce((a, b) => a + b, 0) / mrrValues.length,
    wrong_top1_rate: wrongTop1Rate(decisions, truths),
    decision_utility:
      decisions.reduce((sum, d, i) => sum + queryUtility(d, truths[i]!), 0) /
      decisions.length,
  };
}

// ---------------------------------------------------------------------------
// Mode-specific metrics (Epic 11)
// ---------------------------------------------------------------------------

function computeModeMetrics(
  results: readonly { ranked: RankedHit[]; decision: DecisionOutcome; truth: GroundTruth }[],
  mode: RetrievalMode,
): ModeMetrics {
  if (results.length === 0) {
    return {
      retrieval_mode: mode,
      query_count: 0,
      ndcg_at_10: 0,
      mrr_at_10: 0,
      recall_at_10: 0,
      wrong_top1_rate: 0,
      decision_utility: 0,
    };
  }

  const ndcgValues = results.map((r) => ndcg(r.ranked, r.truth.relevant, 10));
  const mrrValues = results.map((r) => reciprocalRank(r.ranked, r.truth.relevant, 10));
  const recallValues = results.map((r) => recall(r.ranked, r.truth.relevant, 10));
  const decisions = results.map((r) => r.decision);
  const truths = results.map((r) => r.truth);

  const baseMetrics = {
    retrieval_mode: mode,
    query_count: results.length,
    ndcg_at_10: ndcgValues.reduce((a, b) => a + b, 0) / ndcgValues.length,
    mrr_at_10: mrrValues.reduce((a, b) => a + b, 0) / mrrValues.length,
    recall_at_10: recallValues.reduce((a, b) => a + b, 0) / recallValues.length,
    wrong_top1_rate: wrongTop1Rate(decisions, truths),
    decision_utility:
      decisions.reduce((sum, d, i) => sum + queryUtility(d, truths[i]!), 0) /
      decisions.length,
  };

  // Build mode-specific metrics conditionally
  const metrics: ModeMetrics = { ...baseMetrics };

  if (mode === 'producer_browse' || mode === 'region_browse') {
    const diversityScores = results.map((r) => setDiversityScore(r.ranked));
    metrics.diversity_score = diversityScores.reduce((a, b) => a + b, 0) / diversityScores.length;
    const varietyScores = results.map((r) => producerVariety(r.ranked));
    metrics.producer_variety = varietyScores.reduce((a, b) => a + b, 0) / varietyScores.length;

    const coverageScores = results.map((r) =>
      setCoverage(
        new Set(r.ranked.slice(0, 10).map((h) => h.entity_id)),
        r.truth.relevant,
        2,
      ),
    );
    metrics.set_coverage =
      coverageScores.reduce((a, b) => a + b, 0) / coverageScores.length;

    const lineScores = results.map((r) => browseLineDiversityAtK(r.ranked, 10));
    metrics.browse_line_diversity_at_10 =
      lineScores.reduce((a, b) => a + b, 0) / lineScores.length;

    const prestigeScores = results.map((r) => prestigeMeanAtK(r.ranked, 10));
    metrics.prestige_mean_at_10 =
      prestigeScores.reduce((a, b) => a + b, 0) / prestigeScores.length;

    if (mode === 'region_browse') {
      const grapeScores = results.map((r) => grapeVarietyAtK(r.ranked, 10));
      metrics.grape_variety_at_10 =
        grapeScores.reduce((a, b) => a + b, 0) / grapeScores.length;
    }
  }

  if (mode === 'similar_items') {
    metrics.anchor_preservation_score = results.length > 0
      ? results
        .map((r) => anchorPreservationScore(r.truth.expected_entity_id ?? '', r.ranked))
        .reduce((a, b) => a + b, 0) / results.length
      : 0;
    metrics.seed_exclusion_rate = results.length > 0
      ? results
        .map((r) => {
          const anchorId = r.truth.expected_entity_id;
          if (anchorId === undefined || r.ranked.length === 0) {
            return 1;
          }
          return r.ranked.some((hit) => hit.entity_id === anchorId) ? 0 : 1;
        })
        .reduce((a, b) => a + b, 0) / results.length
      : 0;
  }

  if (mode === 'compare_candidates') {
    metrics.attribute_coverage = results.length > 0
      ? results
        .map((r) => {
          if (r.ranked.length === 0) {
            return 0;
          }
          const covered = r.ranked.filter(
            (hit) => hit.producer !== undefined || hit.region !== undefined || (hit.grapes?.length ?? 0) > 0,
          ).length;
          return covered / r.ranked.length;
        })
        .reduce((a, b) => a + b, 0) / results.length
      : 0;
  }

  return metrics;
}

/**
 * Compute entity type confusion matrix for a result set.
 * Tracks what target type results actually resolved to.
 */
function computeEntityTypeMetrics(
  results: readonly { query: GoldenQuery; ranked: RankedHit[]; decision: DecisionOutcome }[],
  targetType: EntityTargetType,
): EntityTypeMetrics {
  if (results.length === 0) {
    return {
      target_type: targetType,
      query_count: 0,
      correct_type_rate: 0,
      confusion_matrix: {
        wine: 0,
        producer: 0,
        region: 0,
        unknown: 0,
      },
    };
  }

  const confusion: Record<EntityTargetType, number> = {
    wine: 0,
    producer: 0,
    region: 0,
    unknown: 0,
  };

  let correctCount = 0;
  for (const r of results) {
    const resolvedType = r.decision.decision_status === 'resolved'
      ? inferResolvedEntityType(r.ranked[0])
      : 'unknown';
    if (resolvedType === targetType) {
      correctCount++;
    }

    confusion[resolvedType]++;
  }

  return {
    target_type: targetType,
    query_count: results.length,
    correct_type_rate: correctCount / results.length,
    confusion_matrix: confusion,
  };
}

export function computeSpecializedFallbackMetrics(
  results: readonly OfflineEvalCaseResult[],
): SpecializedFallbackMetrics {
  const modes = ['producer_browse', 'region_browse', 'compare_candidates'] as const;
  const requestedCounts = {
    producer_browse: 0,
    region_browse: 0,
    compare_candidates: 0,
  };
  const fallbackCounts = {
    producer_browse: 0,
    region_browse: 0,
    compare_candidates: 0,
  };
  const histogram = new Map<string, number>();

  for (const result of results) {
    const requestedMode = result.decision.specialized_route_requested;
    if (
      requestedMode !== 'producer_browse'
      && requestedMode !== 'region_browse'
      && requestedMode !== 'compare_candidates'
    ) {
      continue;
    }
    requestedCounts[requestedMode] += 1;
    if (result.decision.fallback_applied === true) {
      fallbackCounts[requestedMode] += 1;
      if (
        typeof result.decision.fallback_reason === 'string'
        && SPECIALIZED_FALLBACK_REASONS.has(result.decision.fallback_reason)
      ) {
        histogram.set(
          result.decision.fallback_reason,
          (histogram.get(result.decision.fallback_reason) ?? 0) + 1,
        );
      }
    }
  }

  const fallback_rate = Object.fromEntries(
    modes.map((mode) => [
      mode,
      {
        requested_count: requestedCounts[mode],
        fallback_rate: requestedCounts[mode] === 0 ? null : fallbackCounts[mode] / requestedCounts[mode],
      },
    ]),
  ) as SpecializedFallbackMetrics['fallback_rate'];

  return {
    fallback_rate,
    ...(histogram.size > 0 ? { fallback_reason_histogram: Object.fromEntries(histogram) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.verifySplits) {
    console.log('Running split integrity check (RFC-017 §2.5) …');
    const splitResult = await verifyDefaultGoldenSplits();
    if (
      splitResult.stats.train === 0 &&
      splitResult.stats.val === 0 &&
      splitResult.stats.gate === 0
    ) {
      console.error(
        '  verify-splits: no split files (data/splits/*.jsonl). Run build-splits or omit --verify-splits.',
      );
      process.exit(1);
    }
    if (!splitResult.valid) {
      console.error(
        `  Split integrity FAILED (${splitResult.violations.length} violations). First: ${splitResult.violations[0] ?? 'unknown'}`,
      );
      process.exit(1);
    }
    console.log(
      `  Split integrity OK (train=${splitResult.stats.train}, val=${splitResult.stats.val}, gate=${splitResult.stats.gate})\n`,
    );
  }

  console.log(`Loading golden queries from ${args.input} (tier: ${args.tier}) …`);
  const content = await fs.readFile(args.input, 'utf8');
  const { records: allQueries } = parseNdjson<GoldenQuery>(content, args.input);

  // Filter by tier
  const queries = allQueries.filter((q) => q.annotation_tier === args.tier);
  console.log(`  Queries for tier "${args.tier}": ${queries.length} / ${allQueries.length}`);

  if (queries.length === 0) {
    console.log('  No queries found for this tier. Using all queries.');
  }
  const evalQueries = queries.length > 0 ? queries : allQueries;

  // Validate queries before running to prevent silent metric corruption from
  // empty query strings or duplicate qids.
  const emptyQueryRows = evalQueries
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => typeof q.query !== 'string' || q.query.trim() === '');
  if (emptyQueryRows.length > 0) {
    const indices = emptyQueryRows.map(({ i }) => i + 1).join(', ');
    console.error(
      `  ERROR: ${emptyQueryRows.length} eval case(s) have empty query strings (rows: ${indices}). ` +
      'Fix the eval set before running — empty queries produce meaningless metrics.',
    );
    process.exit(1);
  }

  const seenQids = new Set<string>();
  const duplicateQids: string[] = [];
  for (const q of evalQueries) {
    if (seenQids.has(q.qid)) {
      if (!duplicateQids.includes(q.qid)) {
        duplicateQids.push(q.qid);
      }
    } else {
      seenQids.add(q.qid);
    }
  }
  if (duplicateQids.length > 0) {
    console.error(
      `  ERROR: ${duplicateQids.length} duplicate qid(s) found: ${duplicateQids.slice(0, 5).join(', ')}` +
      `${duplicateQids.length > 5 ? ` … (+${duplicateQids.length - 5} more)` : ''}. ` +
      'Duplicate cases inflate per-query metric averages and skew release-gate decisions.',
    );
    process.exit(1);
  }

  const timeoutMs = evalSearchTimeoutMs();
  const concurrency = evalSearchConcurrency();
  console.log(
    `\nExecuting ${evalQueries.length} searches (concurrency=${concurrency}, timeoutMs=${timeoutMs}) …`,
  );

  let lastLogged = 0;
  const allResults = await mapPool(
    evalQueries,
    concurrency,
    async (q) => {
      const { ranked, decision } = await executeSearch(q, timeoutMs);
      const truth = queryToGroundTruth(q);
      return { query: q, ranked, decision, truth };
    },
    (done, total) => {
      if (done % 50 === 0 || done === total) {
        if (done !== lastLogged) {
          lastLogged = done;
          console.log(`  Progress: ${done}/${total}`);
        }
      }
    },
  );

  // Compute global metrics
  console.log('\nComputing metrics …');
  const decisions = allResults.map((r) => r.decision);
  const truths = allResults.map((r) => r.truth);
  const perQueryMetrics = buildOfflinePerQueryMetrics(allResults);

  const globalNdcg = perQueryMetrics.ndcg_at_10.reduce((a, b) => a + b, 0) / allResults.length;
  const globalMrr = perQueryMetrics.mrr_at_10.reduce((a, b) => a + b, 0) / allResults.length;
  const globalRecallAt3 = perQueryMetrics.recall_at_3.reduce((a, b) => a + b, 0) / allResults.length;
  const globalRecall = perQueryMetrics.recall_at_100.reduce((a, b) => a + b, 0) / allResults.length;

  // Scenario slices
  const byScenario: Record<string, ScenarioSlice> = {};
  const scenarioGroups = new Map<string, typeof allResults>();
  for (const r of allResults) {
    const key = r.query.scenario;
    const existing = scenarioGroups.get(key);
    if (existing) {
      existing.push(r);
    } else {
      scenarioGroups.set(key, [r]);
    }
  }
  for (const [scenario, group] of scenarioGroups) {
    byScenario[scenario] = computeSlice(group);
  }

  // Language slices
  const byLanguage: Record<string, ScenarioSlice> = {};
  const langGroups = new Map<string, typeof allResults>();
  for (const r of allResults) {
    const key = r.query.language;
    const existing = langGroups.get(key);
    if (existing) {
      existing.push(r);
    } else {
      langGroups.set(key, [r]);
    }
  }
  for (const [lang, group] of langGroups) {
    byLanguage[lang] = computeSlice(group);
  }

  // Epic 11: Mode-specific slices
  const byModeEntries: [RetrievalMode, ModeMetrics][] = [];
  const modeGroups = new Map<RetrievalMode, typeof allResults>();
  for (const r of allResults) {
    const mode = r.query.retrieval_mode ?? 'entity_lookup';
    const existing = modeGroups.get(mode);
    if (existing) {
      existing.push(r);
    } else {
      modeGroups.set(mode, [r]);
    }
  }
  for (const mode of ALL_RETRIEVAL_MODES) {
    const group = modeGroups.get(mode);
    if (group && group.length > 0) {
      byModeEntries.push([mode, computeModeMetrics(group, mode)]);
    }
  }
  const byMode = Object.fromEntries(byModeEntries) as Record<RetrievalMode, ModeMetrics>;

  // Epic 11: Entity target type slices
  const byTargetTypeEntries: [EntityTargetType, EntityTypeMetrics][] = [];
  const typeGroups = new Map<EntityTargetType, typeof allResults>();
  for (const r of allResults) {
    const targetType = inferEntityTargetTypeFromQuery({
      retrieval_mode: r.query.retrieval_mode,
      query_class: r.query.query_class,
      scenario: r.query.scenario,
    });
    const existing = typeGroups.get(targetType);
    if (existing) {
      existing.push(r);
    } else {
      typeGroups.set(targetType, [r]);
    }
  }
  for (const [targetType, group] of typeGroups) {
    byTargetTypeEntries.push([targetType, computeEntityTypeMetrics(group, targetType)]);
  }
  const byTargetType = Object.fromEntries(byTargetTypeEntries) as Record<EntityTargetType, EntityTypeMetrics>;
  const byExecutionMode = computeExecutionModeSlices(allResults);
  const byBlockingEligible = computeBlockingEligibleSlices(allResults);
  const degradationReasonHistogram = computeDegradationReasonHistogram(allResults);
  const executionModeBlockingEligible = computeExecutionModeBlockingEligibleMatrix(allResults);

  const evalResult: EvalResult = {
    dataset_tier: args.tier,
    query_count: allResults.length,
    ndcg_at_10: globalNdcg,
    mrr_at_10: globalMrr,
    recall_at_3: globalRecallAt3,
    recall_at_100: globalRecall,
    decision_utility: decisionUtilityScore(decisions, truths),
    wrong_top1_rate: wrongTop1Rate(decisions, truths),
    safe_abstain_rate: safeAbstainRate(decisions, truths),
    avoidable_abstain_rate: avoidableAbstainRate(decisions, truths),
    aurc: aurc(decisions, truths),
    e_aurc: excessAurc(decisions, truths),
    ece: ece(decisions, truths),
    by_scenario: byScenario,
    by_language: byLanguage,
    by_execution_mode: byExecutionMode,
    by_blocking_eligible: byBlockingEligible,
    degradation_reason_histogram: degradationReasonHistogram,
    execution_mode_x_blocking_eligible: executionModeBlockingEligible,
  };

  // Add optional Epic 11 fields if present
  if (Object.keys(byMode).length > 0) {
    evalResult.by_mode = byMode;
  }
  evalResult.specialized_fallback = computeSpecializedFallbackMetrics(allResults);
  if (Object.keys(byTargetType).length > 0) {
    evalResult.by_target_type = byTargetType;
  }
  evalResult.release_report = buildDegradationAwareReleaseReport(evalResult);
  evalResult.metric_policy = buildEvalMetricPolicySummary();
  evalResult.non_blocking_metrics = evalResult.metric_policy.advisory_metrics;
  evalResult.diagnostics = {
    per_query_metrics: perQueryMetrics,
  };

  if (args.baselineReport) {
    const baselineRaw = await fs.readFile(args.baselineReport, 'utf8');
    const baseline = JSON.parse(baselineRaw) as StoredOfflineEvalReport;
    evalResult.baseline_comparison = buildOfflineBaselineComparison(
      args.baselineReport,
      evalResult,
      baseline,
      perQueryMetrics,
    );
  }

  // Print summary
  console.log('\n=== EVAL RESULTS ===');
  console.log(`  Queries:          ${evalResult.query_count}`);
  console.log(`  NDCG@10:          ${evalResult.ndcg_at_10.toFixed(4)}`);
  console.log(`  MRR@10:           ${evalResult.mrr_at_10.toFixed(4)}`);
  console.log(`  Recall@3:         ${evalResult.recall_at_3.toFixed(4)}`);
  console.log(`  Recall@100:       ${evalResult.recall_at_100.toFixed(4)}`);
  console.log(`  Decision Utility: ${evalResult.decision_utility.toFixed(4)}`);
  console.log(`  WrongTop1 rate:   ${evalResult.wrong_top1_rate.toFixed(4)}`);
  console.log(`  AURC:             ${evalResult.aurc.toFixed(4)}`);
  console.log(`  ECE:              ${evalResult.ece.toFixed(4)}`);
  if (evalResult.baseline_comparison) {
    console.log('\n  vs baseline:');
    console.log(`    ndcg@10 Δ:       ${evalResult.baseline_comparison.deltas.ndcg_at_10.toFixed(4)}`);
    console.log(`    mrr@10 Δ:        ${evalResult.baseline_comparison.deltas.mrr_at_10.toFixed(4)}`);
    console.log(`    recall@3 Δ:      ${evalResult.baseline_comparison.deltas.recall_at_3.toFixed(4)}`);
    console.log(`    decision util Δ: ${evalResult.baseline_comparison.deltas.decision_utility.toFixed(4)}`);
    if (evalResult.baseline_comparison.significance) {
      const metrics = evalResult.baseline_comparison.significance.significant_metrics;
      console.log(`    significant:     ${metrics.length > 0 ? metrics.join(', ') : 'none'}`);
    } else if (evalResult.baseline_comparison.significance_skipped_reason) {
      console.log(`    significance:    skipped (${evalResult.baseline_comparison.significance_skipped_reason})`);
    }
    if ((evalResult.baseline_comparison.highlights?.length ?? 0) > 0) {
      console.log(`    highlights:      ${evalResult.baseline_comparison.highlights?.join(' | ')}`);
    }
  }

  if (evalResult.release_report) {
    console.log('\n  Degradation-aware release report:');
    console.log(
      `    degraded share:  ${(evalResult.release_report.degraded_query_share.share * 100).toFixed(1)}% `
      + `(${evalResult.release_report.degraded_query_share.query_count}/${evalResult.query_count})`,
    );
    console.log(
      `    heuristic share: ${(evalResult.release_report.heuristic_query_share.share * 100).toFixed(1)}% `
      + `(${evalResult.release_report.heuristic_query_share.query_count}/${evalResult.query_count})`,
    );
    console.log(
      `    blocking share:  ${(evalResult.release_report.blocking_vs_advisory_summary.blocking_eligible.share * 100).toFixed(1)}% `
      + `(${evalResult.release_report.blocking_vs_advisory_summary.blocking_eligible.query_count}/${evalResult.query_count})`,
    );
    console.log(
      `    advisory share:  ${(evalResult.release_report.blocking_vs_advisory_summary.advisory_queries.share * 100).toFixed(1)}% `
      + `(${evalResult.release_report.blocking_vs_advisory_summary.advisory_queries.query_count}/${evalResult.query_count})`,
    );
  }

  console.log('\n  By scenario:');
  for (const [s, m] of Object.entries(evalResult.by_scenario)) {
    console.log(`    ${s}: n=${m.query_count} ndcg=${m.ndcg_at_10.toFixed(3)} wt1=${m.wrong_top1_rate.toFixed(3)}`);
  }

  // Release gate check (only for gate tier)
  const metricViolations = {
    blocking: [] as string[],
    advisory: [] as string[],
  };
  if (args.tier === 'gate') {
    console.log('\n=== RELEASE GATE ===');

    // Global metric gates
    if (evalResult.wrong_top1_rate > RELEASE_GATES.wrong_top1_rate_max) {
      metricViolations.blocking.push(
        createEvalMetricViolation(
          'global',
          'wrong_top1_rate',
          `wrong_top1_rate ${evalResult.wrong_top1_rate.toFixed(4)} > ${RELEASE_GATES.wrong_top1_rate_max}`,
        ).message,
      );
    }
    if (evalResult.recall_at_100 < RELEASE_GATES.recall_at_100_min) {
      metricViolations.blocking.push(
        createEvalMetricViolation(
          'global',
          'recall_at_100',
          `recall_at_100 ${evalResult.recall_at_100.toFixed(4)} < ${RELEASE_GATES.recall_at_100_min}`,
        ).message,
      );
    }
    if (evalResult.ece > 0.10) {
      metricViolations.blocking.push(
        createEvalMetricViolation(
          'global',
          'ece',
          `ece ${evalResult.ece.toFixed(4)} > 0.10 (calibration degraded)`,
        ).message,
      );
    }

    // Scenario-specific gates
    const entitySlices = ['A', 'B', 'H'];
    for (const s of entitySlices) {
      const slice = evalResult.by_scenario[s];
      if (slice && slice.wrong_top1_rate > RELEASE_GATES.entity_resolve_wrong_top1_max) {
        metricViolations.blocking.push(
          createEvalMetricViolation(
            'scenario',
            'wrong_top1_rate',
            `scenario ${s} wrong_top1_rate ${slice.wrong_top1_rate.toFixed(4)} > ${RELEASE_GATES.entity_resolve_wrong_top1_max}`,
          ).message,
        );
      }
    }

    const setSlices = ['E', 'F', 'G'];
    for (const s of setSlices) {
      const slice = evalResult.by_scenario[s];
      if (slice && slice.ndcg_at_10 < RELEASE_GATES.set_retrieval_recall_at_10_min) {
        metricViolations.blocking.push(
          createEvalMetricViolation(
            'scenario',
            'ndcg_at_10',
            `scenario ${s} ndcg_at_10 ${slice.ndcg_at_10.toFixed(4)} < ${RELEASE_GATES.set_retrieval_recall_at_10_min}`,
          ).message,
        );
      }
    }

    const noMatchSlice = evalResult.by_scenario['no_match'];
    if (noMatchSlice && noMatchSlice.wrong_top1_rate > RELEASE_GATES.no_match_false_resolve_max) {
      metricViolations.blocking.push(
        createEvalMetricViolation(
          'scenario',
          'wrong_top1_rate',
          `no_match false_resolve ${noMatchSlice.wrong_top1_rate.toFixed(4)} > ${RELEASE_GATES.no_match_false_resolve_max}`,
        ).message,
      );
    }

    const modeViolations = [] as ReturnType<typeof createEvalMetricViolation>[];

    // Epic 11: Mode-specific release gates (advisory, non-blocking in phase 1)
    if (evalResult.by_mode) {
      for (const [mode, metrics] of Object.entries(evalResult.by_mode)) {
        const gates = (MODE_RELEASE_GATES as Record<string, Record<string, number>>)[mode];
        if (!gates) continue;

        if (gates.wrong_top1_rate_max !== undefined && metrics.wrong_top1_rate > gates.wrong_top1_rate_max) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'wrong_top1_rate',
            `${mode} wrong_top1_rate ${metrics.wrong_top1_rate.toFixed(4)} > ${gates.wrong_top1_rate_max}`,
          ));
        }
        if (gates.ndcg_at_10_min !== undefined && metrics.ndcg_at_10 < gates.ndcg_at_10_min) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'ndcg_at_10',
            `${mode} ndcg_at_10 ${metrics.ndcg_at_10.toFixed(4)} < ${gates.ndcg_at_10_min}`,
          ));
        }
        if (gates.recall_at_10_min !== undefined && metrics.recall_at_10 < gates.recall_at_10_min) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'recall_at_10',
            `${mode} recall_at_10 ${metrics.recall_at_10.toFixed(4)} < ${gates.recall_at_10_min}`,
          ));
        }
        if (
          gates.set_coverage_min !== undefined &&
          metrics.set_coverage !== undefined &&
          metrics.set_coverage < gates.set_coverage_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'set_coverage',
            `${mode} set_coverage ${metrics.set_coverage.toFixed(4)} < ${gates.set_coverage_min}`,
          ));
        }
        if (
          gates.diversity_min !== undefined &&
          metrics.diversity_score !== undefined &&
          metrics.diversity_score < gates.diversity_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'diversity_score',
            `${mode} diversity_score ${metrics.diversity_score.toFixed(4)} < ${gates.diversity_min}`,
          ));
        }
        if (
          gates.producer_variety_min !== undefined &&
          metrics.producer_variety !== undefined &&
          metrics.producer_variety < gates.producer_variety_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'producer_variety',
            `${mode} producer_variety ${metrics.producer_variety.toFixed(4)} < ${gates.producer_variety_min}`,
          ));
        }
        if (
          gates.browse_line_diversity_at_10_min !== undefined &&
          metrics.browse_line_diversity_at_10 !== undefined &&
          metrics.browse_line_diversity_at_10 < gates.browse_line_diversity_at_10_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'browse_line_diversity_at_10',
            `${mode} browse_line_diversity_at_10 ${metrics.browse_line_diversity_at_10.toFixed(4)} < ${gates.browse_line_diversity_at_10_min}`,
          ));
        }
        if (
          gates.grape_variety_at_10_min !== undefined &&
          metrics.grape_variety_at_10 !== undefined &&
          metrics.grape_variety_at_10 < gates.grape_variety_at_10_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'grape_variety_at_10',
            `${mode} grape_variety_at_10 ${metrics.grape_variety_at_10.toFixed(4)} < ${gates.grape_variety_at_10_min}`,
          ));
        }
        if (
          gates.prestige_mean_at_10_min !== undefined &&
          metrics.prestige_mean_at_10 !== undefined &&
          metrics.prestige_mean_at_10 < gates.prestige_mean_at_10_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'prestige_mean_at_10',
            `${mode} prestige_mean_at_10 ${metrics.prestige_mean_at_10.toFixed(4)} < ${gates.prestige_mean_at_10_min}`,
          ));
        }
        if (
          gates.attribute_coverage_min !== undefined &&
          metrics.attribute_coverage !== undefined &&
          metrics.attribute_coverage < gates.attribute_coverage_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'attribute_coverage',
            `${mode} attribute_coverage ${metrics.attribute_coverage.toFixed(4)} < ${gates.attribute_coverage_min}`,
          ));
        }
        if (
          gates.anchor_preservation_min !== undefined &&
          metrics.anchor_preservation_score !== undefined &&
          metrics.anchor_preservation_score < gates.anchor_preservation_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'anchor_preservation_score',
            `${mode} anchor_preservation_score ${metrics.anchor_preservation_score.toFixed(4)} < ${gates.anchor_preservation_min}`,
          ));
        }
        if (
          gates.seed_exclusion_min !== undefined &&
          metrics.seed_exclusion_rate !== undefined &&
          metrics.seed_exclusion_rate < gates.seed_exclusion_min
        ) {
          modeViolations.push(createEvalMetricViolation(
            'mode',
            'seed_exclusion_rate',
            `${mode} seed_exclusion_rate ${metrics.seed_exclusion_rate.toFixed(4)} < ${gates.seed_exclusion_min}`,
          ));
        }
      }
    }

    const advisoryModeViolations = splitEvalMetricViolations(modeViolations).advisory;
    if (advisoryModeViolations.length > 0) {
      for (const violation of advisoryModeViolations) {
        metricViolations.advisory.push(violation.message);
      }
    }

    // Epic 11: Entity target type gates (advisory)
    if (evalResult.by_target_type) {
      const entityTypeGate = 0.10; // max confusion rate
      for (const [targetType, metrics] of Object.entries(evalResult.by_target_type)) {
        const confusionRate = 1 - metrics.correct_type_rate;
        if (confusionRate > entityTypeGate) {
          metricViolations.advisory.push(
            createEvalMetricViolation(
              'entity_type',
              'confusion_rate',
              `Entity type ${targetType} confusion_rate ${confusionRate.toFixed(4)} > ${entityTypeGate}`,
            ).message,
          );
        }
      }
    }

    if (metricViolations.advisory.length > 0) {
      console.log('  [ADVISORY] Non-blocking metrics:');
      for (const violation of metricViolations.advisory) {
        console.log(`    - ${violation}`);
      }
    }

    // Final verdict
    if (metricViolations.blocking.length === 0) {
      console.log('  ✅ RELEASE GATE PASSED');
    } else {
      console.log('  ❌ RELEASE GATE FAILED:');
      for (const v of metricViolations.blocking) {
        console.log(`    - ${v}`);
      }
    }

    // Add gate verdict to result
    const verdict: { passed: boolean; failures: readonly string[]; advisories: readonly string[] } = {
      passed: metricViolations.blocking.length === 0,
      failures: metricViolations.blocking,
      advisories: metricViolations.advisory,
    };
    evalResult.release_gate_verdict = verdict;
  }

  // Write results (after gate verdict is added if applicable)
  await fs.writeFile(args.output, JSON.stringify(evalResult, null, 2) + '\n', 'utf8');

  console.log(`\n  Results written to: ${args.output}`);

  // Epic 6: Run embedding validation if available
  console.log('\n=== EMBEDDING VALIDATION (Epic 6) ===');
  if (shouldSkipEmbeddingValidation()) {
    console.log('⏭️  Skipped (EVAL_SKIP_EMBEDDING_VALIDATION=true)');
    return;
  }
  try {
    const validateEmbeddingPath = new URL('../ltr/validate-embedding.ts', import.meta.url).pathname;
    const fs_exists = await import('node:fs/promises').then((m) =>
      m.access(validateEmbeddingPath).then(() => true).catch(() => false)
    );

    if (fs_exists) {
      console.log('📊 Running embedding validation...');
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);

      try {
        const sampleSize = Math.min(100, evalQueries.length);
        const { stdout } = await execAsync(
          `npx tsx scripts/ltr/validate-embedding.ts --sample ${sampleSize} --tier ${args.tier}`,
          { cwd: process.cwd(), timeout: 300_000 },
        );
        console.log(stdout);
      } catch (execError) {
        const msg = execError instanceof Error ? execError.message : String(execError);
        console.warn(`⚠️  Embedding validation failed: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️  Could not run embedding validation: ${msg}`);
  }
}

function decisionUtilityScore(
  outcomes: readonly DecisionOutcome[],
  truths: readonly GroundTruth[],
): number {
  if (outcomes.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < outcomes.length; i++) {
    total += queryUtility(outcomes[i]!, truths[i]!);
  }
  return total / outcomes.length;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  return import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  void run().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  });
}
