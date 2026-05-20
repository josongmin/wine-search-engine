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

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();
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
  setDiversityScore,
  anchorPreservationScore,
  producerVariety,
  setCoverage,
  browseLineDiversityAtK,
  grapeVarietyAtK,
  prestigeMeanAtK,
  scoreSlotF1,
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
  type ConstraintSlot,
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
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { FixtureLoader } from '../../src/infrastructure/fixture/fixture-loader.js';
import {
  OFFLINE_EVAL_SILVER_CORPUS,
  OFFLINE_EVAL_VAL_CORPUS,
  OFFLINE_EVAL_GATE_CORPUS,
  requireFixtureCorpusPath,
} from './fixture-corpus-paths.js';
import { resolveCliDataPathArg } from './cli-data-path.js';
import { PgEvalBenchmarkRunStore } from '../../src/infrastructure/adapter/pg-eval-benchmark-run-store.js';
import { getCurrentFeatureSchemaHash } from '../../src/domain/ranking/service/feature-parity-hash.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Resolve the default eval corpus path.
 * Priority order (ADR-005 Workstream D):
 *   1. CLI --input flag (handled later in parseArgs)
 *   2. EVAL_CORPUS_PATH env var (backward compat / CI override)
 *   3. External fixture repo corpora/offline-eval/golden-queries-gate.jsonl
 *
 * Engine-local golden query files are no longer the release-gate default.
 * Callers that need a non-SSOT corpus must pass --input or EVAL_CORPUS_PATH
 * explicitly.
 */
function resolveDefaultCorpusPath(): string {
  if (process.env['EVAL_CORPUS_PATH'] != null) {
    return process.env['EVAL_CORPUS_PATH'];
  }
  return requireFixtureCorpusPath(
    OFFLINE_EVAL_GATE_CORPUS,
    'run-offline-eval default input resolution',
  );
}

const DEFAULT_OUTPUT = resolveDataPath('data/eval-results.json');

/**
 * Release gate thresholds.
 * ADR-005 Workstream D: loaded from external fixture thresholds.json (offline_eval suite).
 * Falls back to hard-coded values when fixture repo is unavailable (CI compatibility).
 */
async function loadOfflineEvalGates(args: {
  readonly allowLocalThresholdFallback: boolean;
}): Promise<typeof RELEASE_GATES_FALLBACK> {
  const loader = new FixtureLoader();
  if (!loader.isAvailable()) {
    if (args.allowLocalThresholdFallback) return RELEASE_GATES_FALLBACK;
    throw new Error(
      'run-offline-eval: external fixture thresholds are unavailable. ' +
      'Pass --allow-local-threshold-fallback only for explicit non-gating local runs.',
    );
  }
  const allThresholds = await loader.loadThresholds();
  const suite = allThresholds['offline_eval'];
  if (typeof suite !== 'object' || suite === null) {
    if (args.allowLocalThresholdFallback) return RELEASE_GATES_FALLBACK;
    throw new Error(
      'run-offline-eval: offline_eval thresholds missing from fixture repo. ' +
      'Pass --allow-local-threshold-fallback only for explicit non-gating local runs.',
    );
  }
  const s = suite as Record<string, unknown>;
  function val(key: string, fallback: number): number {
    const entry = s[key];
    if (typeof entry === 'object' && entry !== null) {
      const v = (entry as Record<string, unknown>)['value'];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return fallback;
  }
  return {
    wrong_top1_rate_max: val('wrong_top1_rate_max', RELEASE_GATES_FALLBACK.wrong_top1_rate_max),
    decision_utility_min_delta: val('decision_utility_min_delta', RELEASE_GATES_FALLBACK.decision_utility_min_delta),
    ndcg_at_10_min_delta: val('ndcg_at_10_min_delta', RELEASE_GATES_FALLBACK.ndcg_at_10_min_delta),
    recall_at_100_min: val('recall_at_100_min', RELEASE_GATES_FALLBACK.recall_at_100_min),
    aurc_max_delta: val('aurc_max_delta', RELEASE_GATES_FALLBACK.aurc_max_delta),
    entity_resolve_wrong_top1_max: val('entity_resolve_wrong_top1_max', RELEASE_GATES_FALLBACK.entity_resolve_wrong_top1_max),
    set_retrieval_recall_at_10_min: val('set_retrieval_recall_at_10_min', RELEASE_GATES_FALLBACK.set_retrieval_recall_at_10_min),
    no_match_false_resolve_max: val('no_match_false_resolve_max', RELEASE_GATES_FALLBACK.no_match_false_resolve_max),
  } as const;
}

/**
 * Fallback values (ADR-005: engine repo MUST NOT define competing minimums).
 * These are used only when fixture repo is unavailable — they mirror what is
 * now canonical in eval/thresholds.json. Do NOT lower these without also
 * lowering the fixture repo values.
 */
const RELEASE_GATES_FALLBACK = {
  wrong_top1_rate_max: 0.02,
  decision_utility_min_delta: -0.05,
  ndcg_at_10_min_delta: -0.03,
  recall_at_100_min: 0.90,
  aurc_max_delta: 0.01,
  entity_resolve_wrong_top1_max: 0.03,
  set_retrieval_recall_at_10_min: 0.60,
  no_match_false_resolve_max: 0.05,
} as const;

// Synchronous alias for places that reference RELEASE_GATES before run() loads
// the async version. Replaced at run time via loadOfflineEvalGates().
let RELEASE_GATES: typeof RELEASE_GATES_FALLBACK = RELEASE_GATES_FALLBACK;

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
  fixtureCorpus?: 'silver' | 'val' | 'gate';
  baselineReport?: string;
  /** When true, run `verify-splits` logic before any search (fail-fast on leakage). */
  verifySplits: boolean;
  /** When true, persist per-query diagnostics arrays in the output report. */
  includeDiagnostics: boolean;
  /** Explicit opt-in for non-gating local runs when fixture thresholds are unavailable. */
  allowLocalThresholdFallback: boolean;
}

function parseArgs(argv: string[]): Args {
  const defaultInput = resolveDefaultCorpusPath();
  const out: Args = {
    input: defaultInput,
    output: DEFAULT_OUTPUT,
    tier: 'bronze',
    fixtureCorpus: undefined,
    baselineReport: undefined,
    verifySplits: false,
    includeDiagnostics: false,
    allowLocalThresholdFallback: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = resolveCliDataPathArg(argv[++i] ?? defaultInput);
    else if (a === '--fixture-corpus') {
      const corpus = argv[++i];
      if (corpus === 'silver' || corpus === 'val' || corpus === 'gate') {
        out.fixtureCorpus = corpus;
      }
    }
    else if (a === '--output' || a === '-o') out.output = resolveCliDataPathArg(argv[++i] ?? DEFAULT_OUTPUT);
    else if (a === '--baseline-report') {
      const baselineReport = argv[++i];
      out.baselineReport = baselineReport === undefined ? undefined : resolveCliDataPathArg(baselineReport);
    }
    else if (a === '--tier') {
      const t = argv[++i];
      if (t === 'bronze' || t === 'silver' || t === 'gate') out.tier = t;
    } else if (a === '--verify-splits') {
      out.verifySplits = true;
    } else if (a === '--include-diagnostics') {
      out.includeDiagnostics = true;
    } else if (a === '--allow-local-threshold-fallback') {
      out.allowLocalThresholdFallback = true;
    }
  }
  if (out.fixtureCorpus !== undefined) {
    out.input = requireFixtureCorpusPath(
      out.fixtureCorpus === 'gate'
        ? OFFLINE_EVAL_GATE_CORPUS
        : out.fixtureCorpus === 'silver'
          ? OFFLINE_EVAL_SILVER_CORPUS
          : OFFLINE_EVAL_VAL_CORPUS,
      `run-offline-eval fixture corpus "${out.fixtureCorpus}" resolution`,
    );
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
  if (!Number.isFinite(n) || n < 1) return 4;
  return Math.min(16, n);
}

function shouldSkipEmbeddingValidation(): boolean {
  return process.env['EVAL_SKIP_EMBEDDING_VALIDATION'] === 'true';
}

async function _mapPool<T, R>(
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

async function _consumePool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i]!, i);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

async function forEachPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  onProgress?: (completed: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await fn(items[i]!, i);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

interface SearchResult {
  readonly ranked: RankedHit[];
  readonly decision: DecisionOutcome;
  /** RFC-020: Constraint slots extracted by the engine, if present in meta. */
  readonly extracted_constraints?: readonly ConstraintSlot[];
}

export interface OfflineEvalCaseResult {
  readonly query: GoldenQuery;
  readonly ranked: RankedHit[];
  readonly decision: DecisionOutcome;
  readonly truth: GroundTruth;
  /**
   * RFC-020: Constraint slots extracted by the engine for this query.
   * Populated from the search response `meta.extracted_constraints` field when present.
   * Undefined when the engine did not return constraint extraction data.
   */
  readonly extracted_constraints?: readonly ConstraintSlot[];
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

    // RFC-020: parse extracted_constraints from meta if the engine provides them.
    // Accepts both snake_case and camelCase field names for forward-compatibility.
    const rawExtractedConstraints =
      meta['extracted_constraints'] ?? meta['extractedConstraints'];
    const extractedConstraints: ConstraintSlot[] | undefined = Array.isArray(rawExtractedConstraints)
      ? (rawExtractedConstraints as unknown[]).reduce<ConstraintSlot[]>((acc, item) => {
          if (item !== null && typeof item === 'object') {
            const slot = item as Record<string, unknown>;
            const attribute = slot['attribute'];
            const value = slot['value'];
            if (typeof attribute === 'string' && attribute.length > 0 && typeof value === 'string') {
              const operator = slot['operator'];
              const validOperators = new Set(['eq', 'lt', 'lte', 'gt', 'gte', 'range']);
              acc.push({
                attribute,
                value,
                ...(typeof operator === 'string' && validOperators.has(operator)
                  ? { operator: operator as ConstraintSlot['operator'] }
                  : {}),
              });
            }
          }
          return acc;
        }, [])
      : undefined;

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

    return {
      ranked,
      decision,
      ...(extractedConstraints !== undefined ? { extracted_constraints: extractedConstraints } : {}),
    };
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

  let ndcgTotal = 0;
  let mrrTotal = 0;
  let wrongTop1Count = 0;
  let decisionUtilityTotal = 0;

  for (const result of results) {
    ndcgTotal += ndcg(result.ranked, result.truth.relevant, 10);
    mrrTotal += reciprocalRank(result.ranked, result.truth.relevant, 10);
    if (classifyDecision(result.decision, result.truth) === 'wrong_resolve') {
      wrongTop1Count += 1;
    }
    decisionUtilityTotal += queryUtility(result.decision, result.truth);
  }

  return {
    query_count: results.length,
    ndcg_at_10: ndcgTotal / results.length,
    mrr_at_10: mrrTotal / results.length,
    wrong_top1_rate: wrongTop1Count / results.length,
    decision_utility: decisionUtilityTotal / results.length,
  };
}

// ---------------------------------------------------------------------------
// Mode-specific metrics (Epic 11)
// ---------------------------------------------------------------------------

function _computeModeMetrics(
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

  let ndcgTotal = 0;
  let mrrTotal = 0;
  let recallTotal = 0;
  let wrongTop1Count = 0;
  let decisionUtilityTotal = 0;

  for (const result of results) {
    ndcgTotal += ndcg(result.ranked, result.truth.relevant, 10);
    mrrTotal += reciprocalRank(result.ranked, result.truth.relevant, 10);
    recallTotal += recall(result.ranked, result.truth.relevant, 10);
    if (classifyDecision(result.decision, result.truth) === 'wrong_resolve') {
      wrongTop1Count += 1;
    }
    decisionUtilityTotal += queryUtility(result.decision, result.truth);
  }

  const baseMetrics = {
    retrieval_mode: mode,
    query_count: results.length,
    ndcg_at_10: ndcgTotal / results.length,
    mrr_at_10: mrrTotal / results.length,
    recall_at_10: recallTotal / results.length,
    wrong_top1_rate: wrongTop1Count / results.length,
    decision_utility: decisionUtilityTotal / results.length,
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
function _computeEntityTypeMetrics(
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

interface SpecializedFallbackAccumulator {
  requestedCounts: Record<'producer_browse' | 'region_browse' | 'compare_candidates', number>;
  fallbackCounts: Record<'producer_browse' | 'region_browse' | 'compare_candidates', number>;
  histogram: Map<string, number>;
}

function _createSpecializedFallbackAccumulator(): SpecializedFallbackAccumulator {
  return {
    requestedCounts: {
      producer_browse: 0,
      region_browse: 0,
      compare_candidates: 0,
    },
    fallbackCounts: {
      producer_browse: 0,
      region_browse: 0,
      compare_candidates: 0,
    },
    histogram: new Map<string, number>(),
  };
}

function _addToSpecializedFallbackAccumulator(
  accumulator: SpecializedFallbackAccumulator,
  decision: DecisionOutcome,
): void {
  const requestedMode = decision.specialized_route_requested;
  if (
    requestedMode !== 'producer_browse'
    && requestedMode !== 'region_browse'
    && requestedMode !== 'compare_candidates'
  ) {
    return;
  }

  accumulator.requestedCounts[requestedMode] += 1;
  if (decision.fallback_applied === true) {
    accumulator.fallbackCounts[requestedMode] += 1;
    if (
      typeof decision.fallback_reason === 'string'
      && SPECIALIZED_FALLBACK_REASONS.has(decision.fallback_reason)
    ) {
      accumulator.histogram.set(
        decision.fallback_reason,
        (accumulator.histogram.get(decision.fallback_reason) ?? 0) + 1,
      );
    }
  }
}

function _finalizeSpecializedFallbackAccumulator(
  accumulator: SpecializedFallbackAccumulator,
): SpecializedFallbackMetrics {
  return {
    fallback_rate: {
      producer_browse: {
        requested_count: accumulator.requestedCounts.producer_browse,
        fallback_rate: accumulator.requestedCounts.producer_browse === 0
          ? null
          : accumulator.fallbackCounts.producer_browse / accumulator.requestedCounts.producer_browse,
      },
      region_browse: {
        requested_count: accumulator.requestedCounts.region_browse,
        fallback_rate: accumulator.requestedCounts.region_browse === 0
          ? null
          : accumulator.fallbackCounts.region_browse / accumulator.requestedCounts.region_browse,
      },
      compare_candidates: {
        requested_count: accumulator.requestedCounts.compare_candidates,
        fallback_rate: accumulator.requestedCounts.compare_candidates === 0
          ? null
          : accumulator.fallbackCounts.compare_candidates / accumulator.requestedCounts.compare_candidates,
      },
    },
    ...(accumulator.histogram.size > 0
      ? { fallback_reason_histogram: Object.fromEntries(accumulator.histogram) }
      : {}),
  };
}

interface SliceAccumulator {
  queryCount: number;
  ndcgTotal: number;
  mrrTotal: number;
  wrongTop1Count: number;
  decisionUtilityTotal: number;
}

function createSliceAccumulator(): SliceAccumulator {
  return {
    queryCount: 0,
    ndcgTotal: 0,
    mrrTotal: 0,
    wrongTop1Count: 0,
    decisionUtilityTotal: 0,
  };
}

function addToSliceAccumulator(
  accumulator: SliceAccumulator,
  result: { ranked: RankedHit[]; decision: DecisionOutcome; truth: GroundTruth },
): void {
  accumulator.queryCount += 1;
  accumulator.ndcgTotal += ndcg(result.ranked, result.truth.relevant, 10);
  accumulator.mrrTotal += reciprocalRank(result.ranked, result.truth.relevant, 10);
  if (classifyDecision(result.decision, result.truth) === 'wrong_resolve') {
    accumulator.wrongTop1Count += 1;
  }
  accumulator.decisionUtilityTotal += queryUtility(result.decision, result.truth);
}

function finalizeSliceAccumulator(accumulator: SliceAccumulator): ScenarioSlice {
  if (accumulator.queryCount === 0) {
    return {
      query_count: 0,
      ndcg_at_10: 0,
      mrr_at_10: 0,
      wrong_top1_rate: 0,
      decision_utility: 0,
    };
  }

  return {
    query_count: accumulator.queryCount,
    ndcg_at_10: accumulator.ndcgTotal / accumulator.queryCount,
    mrr_at_10: accumulator.mrrTotal / accumulator.queryCount,
    wrong_top1_rate: accumulator.wrongTop1Count / accumulator.queryCount,
    decision_utility: accumulator.decisionUtilityTotal / accumulator.queryCount,
  };
}

interface ModeAccumulator extends SliceAccumulator {
  recallAt10Total: number;
  diversityScoreTotal: number;
  producerVarietyTotal: number;
  setCoverageTotal: number;
  browseLineDiversityAt10Total: number;
  prestigeMeanAt10Total: number;
  grapeVarietyAt10Total: number;
  anchorPreservationScoreTotal: number;
  seedExclusionRateTotal: number;
  attributeCoverageTotal: number;
}

function createModeAccumulator(): ModeAccumulator {
  return {
    ...createSliceAccumulator(),
    recallAt10Total: 0,
    diversityScoreTotal: 0,
    producerVarietyTotal: 0,
    setCoverageTotal: 0,
    browseLineDiversityAt10Total: 0,
    prestigeMeanAt10Total: 0,
    grapeVarietyAt10Total: 0,
    anchorPreservationScoreTotal: 0,
    seedExclusionRateTotal: 0,
    attributeCoverageTotal: 0,
  };
}

function addToModeAccumulator(
  accumulator: ModeAccumulator,
  result: OfflineEvalCaseResult,
  mode: RetrievalMode,
): void {
  addToSliceAccumulator(accumulator, result);
  accumulator.recallAt10Total += recall(result.ranked, result.truth.relevant, 10);

  if (mode === 'producer_browse' || mode === 'region_browse') {
    accumulator.diversityScoreTotal += setDiversityScore(result.ranked);
    accumulator.producerVarietyTotal += producerVariety(result.ranked);
    accumulator.setCoverageTotal += setCoverage(
      new Set(result.ranked.slice(0, 10).map((hit) => hit.entity_id)),
      result.truth.relevant,
      2,
    );
    accumulator.browseLineDiversityAt10Total += browseLineDiversityAtK(result.ranked, 10);
    accumulator.prestigeMeanAt10Total += prestigeMeanAtK(result.ranked, 10);

    if (mode === 'region_browse') {
      accumulator.grapeVarietyAt10Total += grapeVarietyAtK(result.ranked, 10);
    }
  }

  if (mode === 'similar_items') {
    accumulator.anchorPreservationScoreTotal += anchorPreservationScore(
      result.truth.expected_entity_id ?? '',
      result.ranked,
    );
    accumulator.seedExclusionRateTotal += (() => {
      const anchorId = result.truth.expected_entity_id;
      if (anchorId === undefined || result.ranked.length === 0) {
        return 1;
      }
      return result.ranked.some((hit) => hit.entity_id === anchorId) ? 0 : 1;
    })();
  }

  if (mode === 'compare_candidates') {
    accumulator.attributeCoverageTotal += (() => {
      if (result.ranked.length === 0) {
        return 0;
      }
      const covered = result.ranked.filter(
        (hit) => hit.producer !== undefined || hit.region !== undefined || (hit.grapes?.length ?? 0) > 0,
      ).length;
      return covered / result.ranked.length;
    })();
  }
}

function finalizeModeAccumulator(
  accumulator: ModeAccumulator,
  mode: RetrievalMode,
): ModeMetrics {
  if (accumulator.queryCount === 0) {
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

  const metrics: ModeMetrics = {
    retrieval_mode: mode,
    query_count: accumulator.queryCount,
    ndcg_at_10: accumulator.ndcgTotal / accumulator.queryCount,
    mrr_at_10: accumulator.mrrTotal / accumulator.queryCount,
    recall_at_10: accumulator.recallAt10Total / accumulator.queryCount,
    wrong_top1_rate: accumulator.wrongTop1Count / accumulator.queryCount,
    decision_utility: accumulator.decisionUtilityTotal / accumulator.queryCount,
  };

  if (mode === 'producer_browse' || mode === 'region_browse') {
    metrics.diversity_score = accumulator.diversityScoreTotal / accumulator.queryCount;
    metrics.producer_variety = accumulator.producerVarietyTotal / accumulator.queryCount;
    metrics.set_coverage = accumulator.setCoverageTotal / accumulator.queryCount;
    metrics.browse_line_diversity_at_10 =
      accumulator.browseLineDiversityAt10Total / accumulator.queryCount;
    metrics.prestige_mean_at_10 = accumulator.prestigeMeanAt10Total / accumulator.queryCount;

    if (mode === 'region_browse') {
      metrics.grape_variety_at_10 = accumulator.grapeVarietyAt10Total / accumulator.queryCount;
    }
  }

  if (mode === 'similar_items') {
    metrics.anchor_preservation_score =
      accumulator.anchorPreservationScoreTotal / accumulator.queryCount;
    metrics.seed_exclusion_rate = accumulator.seedExclusionRateTotal / accumulator.queryCount;
  }

  if (mode === 'compare_candidates') {
    metrics.attribute_coverage = accumulator.attributeCoverageTotal / accumulator.queryCount;
  }

  return metrics;
}

interface EntityTypeAccumulator {
  queryCount: number;
  correctCount: number;
  confusion: Record<EntityTargetType, number>;
}

function createEntityTypeAccumulator(): EntityTypeAccumulator {
  return {
    queryCount: 0,
    correctCount: 0,
    confusion: {
      wine: 0,
      producer: 0,
      region: 0,
      unknown: 0,
    },
  };
}

function addToEntityTypeAccumulator(
  accumulator: EntityTypeAccumulator,
  result: OfflineEvalCaseResult,
  targetType: EntityTargetType,
): void {
  accumulator.queryCount += 1;
  const resolvedType = result.decision.decision_status === 'resolved'
    ? inferResolvedEntityType(result.ranked[0])
    : 'unknown';
  if (resolvedType === targetType) {
    accumulator.correctCount += 1;
  }
  accumulator.confusion[resolvedType] += 1;
}

function finalizeEntityTypeAccumulator(
  accumulator: EntityTypeAccumulator,
  targetType: EntityTargetType,
): EntityTypeMetrics {
  return {
    target_type: targetType,
    query_count: accumulator.queryCount,
    correct_type_rate: accumulator.queryCount === 0 ? 0 : accumulator.correctCount / accumulator.queryCount,
    confusion_matrix: accumulator.confusion,
  };
}

// ---------------------------------------------------------------------------
// RFC-020: Slot F1 aggregate helper (exported for unit testing)
// ---------------------------------------------------------------------------

export interface SlotF1Aggregates {
  readonly mean_slot_f1_strict: number;
  readonly mean_slot_f1_relaxed: number;
  readonly slot_f1_query_count: number;
}

/**
 * Compute aggregate Slot F1 metrics across a result set.
 *
 * A query contributes to the aggregate only when:
 *   - `result.query.expected_constraints` is a non-null array (annotated)
 *   - `result.extracted_constraints` is a non-null array (engine emitted them)
 *
 * Returns `undefined` when no query satisfies both conditions (graceful no-op).
 */
export function computeSlotF1Aggregates(
  results: readonly OfflineEvalCaseResult[],
): SlotF1Aggregates | undefined {
  let strictTotal = 0;
  let relaxedTotal = 0;
  let count = 0;

  for (const result of results) {
    if (result.query.expected_constraints == null || result.extracted_constraints == null) {
      continue;
    }
    strictTotal += scoreSlotF1(result.extracted_constraints, result.query.expected_constraints, 'strict').f1;
    relaxedTotal += scoreSlotF1(result.extracted_constraints, result.query.expected_constraints, 'relaxed').f1;
    count += 1;
  }

  if (count === 0) {
    return undefined;
  }

  return {
    mean_slot_f1_strict: strictTotal / count,
    mean_slot_f1_relaxed: relaxedTotal / count,
    slot_f1_query_count: count,
  };
}

interface CountBucket {
  query_count: number;
}

function incrementCountBucket<K>(map: Map<K, CountBucket>, key: K): void {
  const bucket = map.get(key) ?? { query_count: 0 };
  bucket.query_count += 1;
  map.set(key, bucket);
}

interface AurcPoint {
  confidence: number;
  wrong: boolean;
}

interface EceBucketAccumulator {
  totalConf: number;
  totalCorrect: number;
  count: number;
}

interface GlobalDecisionAccumulator {
  queryCount: number;
  decisionUtilityTotal: number;
  wrongTop1Count: number;
  safeAbstainCount: number;
  avoidableAbstainCount: number;
  aurcPoints: AurcPoint[];
  eceBuckets: EceBucketAccumulator[];
  resolvedCount: number;
}

function createGlobalDecisionAccumulator(bins = 10): GlobalDecisionAccumulator {
  return {
    queryCount: 0,
    decisionUtilityTotal: 0,
    wrongTop1Count: 0,
    safeAbstainCount: 0,
    avoidableAbstainCount: 0,
    aurcPoints: [],
    eceBuckets: Array.from({ length: bins }, () => ({
      totalConf: 0,
      totalCorrect: 0,
      count: 0,
    })),
    resolvedCount: 0,
  };
}

function addToGlobalDecisionAccumulator(
  accumulator: GlobalDecisionAccumulator,
  decision: DecisionOutcome,
  truth: GroundTruth,
): void {
  accumulator.queryCount += 1;
  const category = classifyDecision(decision, truth);
  accumulator.decisionUtilityTotal += queryUtility(decision, truth);

  if (category === 'wrong_resolve') {
    accumulator.wrongTop1Count += 1;
  } else if (category === 'safe_abstain') {
    accumulator.safeAbstainCount += 1;
  } else if (category === 'avoidable_abstain') {
    accumulator.avoidableAbstainCount += 1;
  }

  accumulator.aurcPoints.push({
    confidence: decision.decision_confidence,
    wrong: category === 'wrong_resolve',
  });

  if (decision.decision_status === 'resolved') {
    accumulator.resolvedCount += 1;
    const bins = accumulator.eceBuckets.length;
    const binIndex = Math.min(Math.floor(decision.decision_confidence * bins), bins - 1);
    const bucket = accumulator.eceBuckets[binIndex]!;
    bucket.totalConf += decision.decision_confidence;
    bucket.totalCorrect += category === 'correct_resolve' ? 1 : 0;
    bucket.count += 1;
  }
}

function finalizeGlobalDecisionAccumulator(accumulator: GlobalDecisionAccumulator): {
  decisionUtility: number;
  wrongTop1Rate: number;
  safeAbstainRate: number;
  avoidableAbstainRate: number;
  aurc: number;
  excessAurc: number;
  ece: number;
} {
  const queryCount = accumulator.queryCount;
  if (queryCount === 0) {
    return {
      decisionUtility: 0,
      wrongTop1Rate: 0,
      safeAbstainRate: 0,
      avoidableAbstainRate: 0,
      aurc: 0,
      excessAurc: 0,
      ece: 0,
    };
  }

  const sortedPoints = [...accumulator.aurcPoints].sort(
    (left, right) => right.confidence - left.confidence,
  );
  let wrongSoFar = 0;
  let aurcArea = 0;
  for (let i = 0; i < sortedPoints.length; i++) {
    if (sortedPoints[i]!.wrong) {
      wrongSoFar += 1;
    }
    aurcArea += (wrongSoFar / (i + 1)) * (1 / sortedPoints.length);
  }

  const wrongTotal = accumulator.wrongTop1Count;
  const correctCount = queryCount - wrongTotal;
  let optimalAurcArea = 0;
  for (let i = 0; i < queryCount; i++) {
    const risk = i < correctCount ? 0 : (i - correctCount + 1) / (i + 1);
    optimalAurcArea += risk / queryCount;
  }

  let totalEce = 0;
  if (accumulator.resolvedCount > 0) {
    for (const bucket of accumulator.eceBuckets) {
      if (bucket.count === 0) {
        continue;
      }
      const avgConf = bucket.totalConf / bucket.count;
      const avgAcc = bucket.totalCorrect / bucket.count;
      totalEce += (bucket.count / accumulator.resolvedCount) * Math.abs(avgConf - avgAcc);
    }
  }

  return {
    decisionUtility: accumulator.decisionUtilityTotal / queryCount,
    wrongTop1Rate: accumulator.wrongTop1Count / queryCount,
    safeAbstainRate: accumulator.safeAbstainCount / queryCount,
    avoidableAbstainRate: accumulator.avoidableAbstainCount / queryCount,
    aurc: aurcArea,
    excessAurc: aurcArea - optimalAurcArea,
    ece: totalEce,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ADR-005 Workstream D: load release gate thresholds from fixture repo.
  RELEASE_GATES = await loadOfflineEvalGates({
    allowLocalThresholdFallback: args.allowLocalThresholdFallback,
  });

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

  const EVAL_JOB_TIMEOUT_MS = Number.parseInt(process.env['EVAL_JOB_TIMEOUT_MS'] ?? '0', 10) || 30 * 60 * 1000; // 30 min default

  const timeoutMs = evalSearchTimeoutMs();
  const concurrency = evalSearchConcurrency();
  console.log(
    `\nExecuting ${evalQueries.length} searches (concurrency=${concurrency}, timeoutMs=${timeoutMs}) …`,
  );

  let lastLogged = 0;

  const jobTimeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Eval job timed out after ${EVAL_JOB_TIMEOUT_MS}ms`)),
      EVAL_JOB_TIMEOUT_MS,
    ),
  );

  const needsPerQueryMetrics = args.includeDiagnostics || args.baselineReport !== undefined;
  const perQueryMetrics = needsPerQueryMetrics
    ? {
        ndcg_at_10: [] as number[],
        mrr_at_10: [] as number[],
        recall_at_3: [] as number[],
        recall_at_100: [] as number[],
        decision_utility: [] as number[],
        non_wrong_top1_rate: [] as number[],
      }
    : undefined;

  const globalDecisionAccumulator = createGlobalDecisionAccumulator();
  let globalNdcg = 0;
  let globalMrr = 0;
  let globalRecallAt3 = 0;
  let globalRecall = 0;
  let failedQueryCount = 0;
  let succeededNdcgTotal = 0;
  let succeededQueryCount = 0;
  const scenarioAccumulators = new Map<string, SliceAccumulator>();
  const languageAccumulators = new Map<string, SliceAccumulator>();
  const modeAccumulators = new Map<RetrievalMode, ModeAccumulator>();
  const targetTypeAccumulators = new Map<EntityTargetType, EntityTypeAccumulator>();
  const executionModeAccumulators = new Map<EvalExecutionModeBucket, SliceAccumulator>();
  const blockingEligibleAccumulators = new Map<EvalBlockingEligibleBucket, SliceAccumulator>();
  const executionModeCounts = new Map<EvalExecutionModeBucket, CountBucket>();
  const blockingEligibleCounts = new Map<EvalBlockingEligibleBucket, CountBucket>();
  const executionModeBlockingEligibleCounts = new Map<EvalExecutionModeBucket, Map<EvalBlockingEligibleBucket, number>>();
  const degradationReasonHistogramMap = new Map<string, number>();
  const specializedRequestedCounts = {
    producer_browse: 0,
    region_browse: 0,
    compare_candidates: 0,
  };
  const specializedFallbackCounts = {
    producer_browse: 0,
    region_browse: 0,
    compare_candidates: 0,
  };
  const specializedFallbackHistogram = new Map<string, number>();

  // RFC-020: Slot F1 accumulators — only count queries where expected_constraints is present.
  let slotF1StrictTotal = 0;
  let slotF1RelaxedTotal = 0;
  let slotF1QueryCount = 0;

  await Promise.race([
    forEachPool(
      evalQueries,
      concurrency,
      async (q) => {
        let ranked: RankedHit[];
        let decision: DecisionOutcome;
        let searchExtractedConstraints: readonly ConstraintSlot[] | undefined;
        try {
          const searchResult = await executeSearch(q, timeoutMs);
          ranked = searchResult.ranked;
          decision = searchResult.decision;
          searchExtractedConstraints = searchResult.extracted_constraints;
        } catch (err) {
          console.error(`[eval] query "${q.query}" (qid=${q.qid}) threw — recording as error:`, err);
          ranked = [];
          decision = {
            decision_status: 'failed',
            top_entity_id: null,
            decision_confidence: 0,
          };
        }

        const truth = queryToGroundTruth(q);
        const result: OfflineEvalCaseResult = {
          query: q,
          ranked,
          decision,
          truth,
          ...(searchExtractedConstraints !== undefined
            ? { extracted_constraints: searchExtractedConstraints }
            : {}),
        };

        const ndcgAt10 = ndcg(ranked, truth.relevant, 10);
        const mrrAt10 = reciprocalRank(ranked, truth.relevant, 10);
        const recallAt3 = recall(ranked, truth.relevant, 3);
        const recallAt100 = recall(ranked, truth.relevant, 100);
        const decisionUtilityValue = queryUtility(decision, truth);
        const nonWrongTop1RateValue = classifyDecision(decision, truth) === 'wrong_resolve' ? 0 : 1;

        globalNdcg += ndcgAt10;
        globalMrr += mrrAt10;
        globalRecallAt3 += recallAt3;
        globalRecall += recallAt100;
        addToGlobalDecisionAccumulator(globalDecisionAccumulator, decision, truth);

        if (decision.decision_status === 'failed' || (decision.decision_status as string) === 'error') {
          failedQueryCount += 1;
        } else {
          succeededNdcgTotal += ndcgAt10;
          succeededQueryCount += 1;
        }

        if (perQueryMetrics) {
          perQueryMetrics.ndcg_at_10.push(ndcgAt10);
          perQueryMetrics.mrr_at_10.push(mrrAt10);
          perQueryMetrics.recall_at_3.push(recallAt3);
          perQueryMetrics.recall_at_100.push(recallAt100);
          perQueryMetrics.decision_utility.push(decisionUtilityValue);
          perQueryMetrics.non_wrong_top1_rate.push(nonWrongTop1RateValue);
        }

        // RFC-020: Slot F1 — compute when query has expected_constraints annotated.
        // Graceful no-op when either expected_constraints is absent (annotation not yet done)
        // or extracted_constraints is absent (engine does not yet emit them).
        if (q.expected_constraints != null && result.extracted_constraints != null) {
          const strictResult = scoreSlotF1(
            result.extracted_constraints,
            q.expected_constraints,
            'strict',
          );
          const relaxedResult = scoreSlotF1(
            result.extracted_constraints,
            q.expected_constraints,
            'relaxed',
          );
          slotF1StrictTotal += strictResult.f1;
          slotF1RelaxedTotal += relaxedResult.f1;
          slotF1QueryCount += 1;
        }

        const scenarioAccumulator =
          scenarioAccumulators.get(result.query.scenario) ?? createSliceAccumulator();
        addToSliceAccumulator(scenarioAccumulator, result);
        scenarioAccumulators.set(result.query.scenario, scenarioAccumulator);

        const languageAccumulator =
          languageAccumulators.get(result.query.language) ?? createSliceAccumulator();
        addToSliceAccumulator(languageAccumulator, result);
        languageAccumulators.set(result.query.language, languageAccumulator);

        const mode = result.query.retrieval_mode ?? 'entity_lookup';
        const modeAccumulator = modeAccumulators.get(mode) ?? createModeAccumulator();
        addToModeAccumulator(modeAccumulator, result, mode);
        modeAccumulators.set(mode, modeAccumulator);

        const targetType = inferEntityTargetTypeFromQuery({
          retrieval_mode: result.query.retrieval_mode,
          query_class: result.query.query_class,
          scenario: result.query.scenario,
        });
        const targetTypeAccumulator =
          targetTypeAccumulators.get(targetType) ?? createEntityTypeAccumulator();
        addToEntityTypeAccumulator(targetTypeAccumulator, result, targetType);
        targetTypeAccumulators.set(targetType, targetTypeAccumulator);

        const executionModeBucket = toExecutionModeBucket(decision);
        const blockingEligibleBucket = toBlockingEligibleBucket(decision);
        incrementCountBucket(executionModeCounts, executionModeBucket);
        incrementCountBucket(blockingEligibleCounts, blockingEligibleBucket);

        const executionModeAccumulator =
          executionModeAccumulators.get(executionModeBucket) ?? createSliceAccumulator();
        addToSliceAccumulator(executionModeAccumulator, result);
        executionModeAccumulators.set(executionModeBucket, executionModeAccumulator);

        const blockingEligibleAccumulator =
          blockingEligibleAccumulators.get(blockingEligibleBucket) ?? createSliceAccumulator();
        addToSliceAccumulator(blockingEligibleAccumulator, result);
        blockingEligibleAccumulators.set(blockingEligibleBucket, blockingEligibleAccumulator);

        const matrixRow =
          executionModeBlockingEligibleCounts.get(executionModeBucket) ?? new Map<EvalBlockingEligibleBucket, number>();
        matrixRow.set(
          blockingEligibleBucket,
          (matrixRow.get(blockingEligibleBucket) ?? 0) + 1,
        );
        executionModeBlockingEligibleCounts.set(executionModeBucket, matrixRow);

        for (const reason of decision.degradation_reasons ?? []) {
          degradationReasonHistogramMap.set(reason, (degradationReasonHistogramMap.get(reason) ?? 0) + 1);
        }

        const requestedMode = decision.specialized_route_requested;
        if (
          requestedMode === 'producer_browse'
          || requestedMode === 'region_browse'
          || requestedMode === 'compare_candidates'
        ) {
          specializedRequestedCounts[requestedMode] += 1;
          if (decision.fallback_applied === true) {
            specializedFallbackCounts[requestedMode] += 1;
            if (
              typeof decision.fallback_reason === 'string'
              && SPECIALIZED_FALLBACK_REASONS.has(decision.fallback_reason)
            ) {
              specializedFallbackHistogram.set(
                decision.fallback_reason,
                (specializedFallbackHistogram.get(decision.fallback_reason) ?? 0) + 1,
              );
            }
          }
        }
      },
      (done, total) => {
        if (done % 50 === 0 || done === total) {
          if (done !== lastLogged) {
            lastLogged = done;
            console.log(`  Progress: ${done}/${total}`);
          }
        }
      },
    ),
    jobTimeoutPromise,
  ]);

  console.log('\nComputing metrics …');
  const queryCount = Math.max(1, evalQueries.length);
  globalNdcg /= queryCount;
  globalMrr /= queryCount;
  globalRecallAt3 /= queryCount;
  globalRecall /= queryCount;

  // Warn when >5% of queries failed (network/timeout errors in eval execution)
  const failedFraction = failedQueryCount / queryCount;
  if (failedFraction > 0.05) {
    console.warn(
      `[eval] WARNING: ${failedQueryCount}/${evalQueries.length} queries failed (${(failedFraction * 100).toFixed(1)}% > 5% threshold). ` +
      'Metrics may be unreliable. Check SEARCH_API_URL and network connectivity.',
      { failedCount: failedQueryCount, totalCount: evalQueries.length, failedFraction },
    );
  }

  const ndcgSucceededOnly = succeededQueryCount > 0 ? succeededNdcgTotal / succeededQueryCount : 0;

  const byScenario = Object.fromEntries(
    [...scenarioAccumulators.entries()].map(([scenario, accumulator]) => [
      scenario,
      finalizeSliceAccumulator(accumulator),
    ]),
  ) as Record<string, ScenarioSlice>;

  const byLanguage = Object.fromEntries(
    [...languageAccumulators.entries()].map(([language, accumulator]) => [
      language,
      finalizeSliceAccumulator(accumulator),
    ]),
  ) as Record<string, ScenarioSlice>;

  const byModeEntries: [RetrievalMode, ModeMetrics][] = [];
  for (const mode of ALL_RETRIEVAL_MODES) {
    const accumulator = modeAccumulators.get(mode);
    if (accumulator && accumulator.queryCount > 0) {
      byModeEntries.push([mode, finalizeModeAccumulator(accumulator, mode)]);
    }
  }
  const byMode = Object.fromEntries(byModeEntries) as Record<RetrievalMode, ModeMetrics>;

  const byTargetType = Object.fromEntries(
    [...targetTypeAccumulators.entries()].map(([targetType, accumulator]) => [
      targetType,
      finalizeEntityTypeAccumulator(accumulator, targetType),
    ]),
  ) as Record<EntityTargetType, EntityTypeMetrics>;
  const byExecutionMode = Object.fromEntries(
    [...executionModeAccumulators.entries()].map(([bucket, accumulator]) => [
      bucket,
      finalizeSliceAccumulator(accumulator),
    ]),
  ) as Record<EvalExecutionModeBucket, ScenarioSlice>;
  const byBlockingEligible = Object.fromEntries(
    [...blockingEligibleAccumulators.entries()].map(([bucket, accumulator]) => [
      bucket,
      finalizeSliceAccumulator(accumulator),
    ]),
  ) as Record<EvalBlockingEligibleBucket, ScenarioSlice>;
  const degradationReasonHistogram = Object.fromEntries(
    [...degradationReasonHistogramMap.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  const executionModeBlockingEligible = Object.fromEntries(
    [...executionModeBlockingEligibleCounts.entries()].map(([modeBucket, row]) => [
      modeBucket,
      Object.fromEntries(
        [...row.entries()].map(([blockingBucket, count]) => [
          blockingBucket,
          {
            query_count: count,
            share: count / queryCount,
          },
        ]),
      ),
    ]),
  ) as Record<EvalExecutionModeBucket, Partial<Record<EvalBlockingEligibleBucket, EvalCountShareBucket>>>;
  const specializedFallback: SpecializedFallbackMetrics = {
    fallback_rate: {
      producer_browse: {
        requested_count: specializedRequestedCounts.producer_browse,
        fallback_rate:
          specializedRequestedCounts.producer_browse === 0
            ? null
            : specializedFallbackCounts.producer_browse / specializedRequestedCounts.producer_browse,
      },
      region_browse: {
        requested_count: specializedRequestedCounts.region_browse,
        fallback_rate:
          specializedRequestedCounts.region_browse === 0
            ? null
            : specializedFallbackCounts.region_browse / specializedRequestedCounts.region_browse,
      },
      compare_candidates: {
        requested_count: specializedRequestedCounts.compare_candidates,
        fallback_rate:
          specializedRequestedCounts.compare_candidates === 0
            ? null
            : specializedFallbackCounts.compare_candidates / specializedRequestedCounts.compare_candidates,
      },
    },
    ...(specializedFallbackHistogram.size > 0
      ? { fallback_reason_histogram: Object.fromEntries(specializedFallbackHistogram) }
      : {}),
  };
  const globalDecisionMetrics = finalizeGlobalDecisionAccumulator(globalDecisionAccumulator);

  const evalResult: EvalResult = {
    dataset_tier: args.tier,
    query_count: evalQueries.length,
    ndcg_at_10: globalNdcg,
    ndcg_succeeded_only: ndcgSucceededOnly,
    mrr_at_10: globalMrr,
    recall_at_3: globalRecallAt3,
    recall_at_100: globalRecall,
    decision_utility: globalDecisionMetrics.decisionUtility,
    wrong_top1_rate: globalDecisionMetrics.wrongTop1Rate,
    safe_abstain_rate: globalDecisionMetrics.safeAbstainRate,
    avoidable_abstain_rate: globalDecisionMetrics.avoidableAbstainRate,
    aurc: globalDecisionMetrics.aurc,
    e_aurc: globalDecisionMetrics.excessAurc,
    ece: globalDecisionMetrics.ece,
    by_scenario: byScenario,
    by_language: byLanguage,
    by_execution_mode: byExecutionMode,
    by_blocking_eligible: byBlockingEligible,
    degradation_reason_histogram: degradationReasonHistogram,
    execution_mode_x_blocking_eligible: executionModeBlockingEligible,
    // RFC-020: Slot F1 — include aggregate metrics when at least one query was scored.
    ...(slotF1QueryCount > 0
      ? {
          mean_slot_f1_strict: slotF1StrictTotal / slotF1QueryCount,
          mean_slot_f1_relaxed: slotF1RelaxedTotal / slotF1QueryCount,
          slot_f1_query_count: slotF1QueryCount,
        }
      : {}),
  };

  // Add optional Epic 11 fields if present
  if (Object.keys(byMode).length > 0) {
    evalResult.by_mode = byMode;
  }
  evalResult.specialized_fallback = specializedFallback;
  if (Object.keys(byTargetType).length > 0) {
    evalResult.by_target_type = byTargetType;
  }
  evalResult.release_report = buildDegradationAwareReleaseReport(evalResult);
  evalResult.metric_policy = buildEvalMetricPolicySummary();
  evalResult.non_blocking_metrics = evalResult.metric_policy.advisory_metrics;
  if (args.includeDiagnostics) {
    evalResult.diagnostics = {
      per_query_metrics: perQueryMetrics,
    };
  }

  if (args.baselineReport) {
    const baselineRaw = await fs.readFile(args.baselineReport, 'utf8');
    const baseline = JSON.parse(baselineRaw) as StoredOfflineEvalReport;
    evalResult.baseline_comparison = buildOfflineBaselineComparison(
      args.baselineReport,
      evalResult,
      baseline,
      perQueryMetrics!,
    );
  }

  // Validate conformal coverage guarantee (RFC-017 §4.1).
  // Recall@100 serves as the empirical coverage of the conformal prediction set
  // (the top-100 results). Under a valid conformal calibration with alpha=0.1,
  // we expect coverage >= 90%. A 5% tolerance is allowed for finite-sample noise.
  {
    const CONFORMAL_ALPHA = 0.1;
    const expectedCoverage = 1 - CONFORMAL_ALPHA; // 0.9
    const empiricalCoverage = evalResult.recall_at_100;
    if (empiricalCoverage < expectedCoverage - 0.05) {
      console.warn(
        `[Eval] Conformal coverage ${(empiricalCoverage * 100).toFixed(1)}% < expected ` +
        `${(expectedCoverage * 100).toFixed(1)}% (alpha=${CONFORMAL_ALPHA}) — ` +
        'calibration may be invalid; consider re-running conformal calibration',
      );
    }
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
  if (evalResult.mean_slot_f1_strict !== undefined) {
    console.log(
      `  SlotF1 (strict):  ${evalResult.mean_slot_f1_strict.toFixed(4)}` +
      `  (n=${evalResult.slot_f1_query_count ?? 0})`,
    );
    console.log(`  SlotF1 (relaxed): ${(evalResult.mean_slot_f1_relaxed ?? 0).toFixed(4)}`);
  }
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

  // Persist benchmark run to DB (best-effort — eval succeeds even if DB is unavailable)
  try {
    const { getPgPool } = await import('../../src/infrastructure/db/pg-pool.js');
    const pool = getPgPool();
    try {
      const evalBenchmarkRunStore = new PgEvalBenchmarkRunStore(pool);
      const releaseGatePassed = evalResult.release_gate_verdict?.passed ?? false;
      await evalBenchmarkRunStore.saveRun({
        benchmarkKind: 'offline_eval',
        evalDatasetVersion: args.tier,
        featureSchemaHash: getCurrentFeatureSchemaHash(),
        queryCount: evalResult.query_count,
        mrr: evalResult.mrr_at_10,
        recallAt3: evalResult.recall_at_3,
        releaseGatePassed,
        activationStatus: 'shadow_only',
        report: evalResult as unknown as Readonly<Record<string, unknown>>,
        metrics: {
          ndcg_at_10: evalResult.ndcg_at_10,
          decision_utility: evalResult.decision_utility,
          recall_at_100: evalResult.recall_at_100,
        },
      });
      console.log('  Benchmark run persisted to DB.');
    } finally {
      await pool.end();
    }
  } catch (persistErr: unknown) {
    const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    console.warn(`  [WARN] Could not persist benchmark run to DB: ${msg}`);
  }

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
