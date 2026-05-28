#!/usr/bin/env tsx
/**
 * Fixture-native search_feature_behavior benchmark runner.
 * ADR-005 Workstream A.
 *
 * Evaluates:
 * - top-3 retrieval accuracy for attribute-driven queries
 * - hard-constraint compliance (results[*].constraints.unmet)
 * - min pass rate
 * - case-level failure diagnostics
 *
 * Reads benchmark truth from wine-engine-fixture (ADR-004/005 SSOT).
 * Thresholds come exclusively from external fixture thresholds.json.
 *
 * Usage:
 *   npx tsx scripts/eval/run-search-feature-behavior-fixture-eval.ts
 *   npx tsx scripts/eval/run-search-feature-behavior-fixture-eval.ts \
 *     --output data/sfb-results.json --api-url http://localhost:3000
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  loadFixtureCases,
  loadFixtureThresholds,
  readNumericThreshold,
} from './external-fixture-benchmark.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import {
  buildBenchmarkRequestHeaders,
  collectLiveBenchmarkRuntimeMetadata,
  resolveBenchmarkSearchEndpoint,
  runLiveBenchmarkPreflight,
  type BenchmarkExecutionLane,
} from './live-benchmark-preflight.js';
import { resolveCliDataPathArg } from './cli-data-path.js';
import { PgEvalBenchmarkRunStore } from '../../src/infrastructure/adapter/pg-eval-benchmark-run-store.js';
import { getCurrentFeatureSchemaHash } from '../../src/domain/ranking/service/feature-parity-hash.js';
import { createContainer } from '../../src/config/container.js';
import { config } from '../../src/config/env.js';
import { closePgPool } from '../../src/infrastructure/db/pg-pool.js';
import {
  countStringMix,
  toReportProvenance,
  type EvalBenchmarkReportProvenance,
} from './benchmark-provenance.js';
import { hashStableJson } from '../../src/domain/shared/utils/stable-json.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../src/domain/response/model/comparison-response.js';

const SUITE_ID = 'search_feature_behavior' as const;
const DEFAULT_OUTPUT = resolveDataPath('data/search-feature-behavior-fixture-eval-results.json');

/** Maximum failure records included in the report (keeps JSON manageable). */
const MAX_FAILURES_IN_REPORT = 50;

/** Default concurrency for live API calls. */
const DEFAULT_CONCURRENCY = 4;
const MIN_SFB_QUERY_COUNT = 12;
const MIN_SFB_DISTINCT_CATEGORIES = 3;
const MIN_SFB_DISTINCT_DIFFICULTIES = 2;
const MIN_SFB_TARGET_ENTITY_CASES = 6;
const MIN_SFB_CONSTRAINT_BEARING_CASES = 4;
const MAX_SFB_ENTITY_SHARE = 0.4;
const SUPPORTED_SFB_EVALUATION_MODES = ['exact_entity_top1', 'exact_entity_topk', 'answer_rubric'] as const;
type SearchFeatureBehaviorRuntimeTarget = 'http' | 'inprocess';

interface CliArgs {
  readonly output: string;
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly executionLane: BenchmarkExecutionLane;
  readonly runtimeTarget: SearchFeatureBehaviorRuntimeTarget;
  readonly debugKey?: string;
  readonly useThresholds: boolean;
  readonly smokePredictions: boolean;
}

/** Typed view of a search_feature_behavior fixture case. */
interface SearchFeatureBehaviorCase {
  readonly benchmark_id: string;
  readonly query: string;
  readonly category: string;
  readonly language: 'ko' | 'en' | 'mixed';
  readonly difficulty: 'easy' | 'medium' | 'hard';
  readonly top_k: number;
  readonly evaluation_mode: string;
  readonly target_entity_id: string | undefined;
  readonly expected_constraints_summary: readonly string[];
  readonly answer_must_match: readonly string[];
  readonly answer_must_not_match: readonly string[];
}

interface SearchResultItem {
  readonly entity_id: string;
  readonly canonical_label: string;
  readonly wine_type?: string | undefined;
  readonly style?: string | undefined;
  readonly constraints: {
    readonly matched: readonly string[];
    readonly unmet: readonly string[];
    readonly inferred: readonly string[];
  };
  readonly violated_constraints: readonly string[] | undefined;
  readonly match_reasons: readonly string[] | undefined;
}

interface LiveSearchResponse {
  readonly results: readonly SearchResultItem[];
  readonly decision_status?: string;
}

interface InProcessSearchCaller {
  readonly execute: (query: string, timeoutMs: number) => Promise<LiveSearchResponse>;
  readonly close: () => Promise<void>;
}

interface CaseResult {
  readonly benchmark_id: string;
  readonly query: string;
  readonly pass: boolean;
  readonly topKHit: boolean;
  readonly constraintCompliant: boolean;
  readonly top_entity_id: string | null;
  readonly top_k_entities: readonly string[];
  readonly expected_constraints_summary: readonly string[];
  readonly constraint_violation_reason: string | null;
}

/** Required output report shape (ADR-005 Workstream A). */
export interface SearchFeatureBehaviorFixtureReport {
  readonly benchmark: 'search-feature-behavior-fixture';
  readonly suite_id: 'search_feature_behavior';
  readonly execution_lane: BenchmarkExecutionLane;
  readonly provenance?: EvalBenchmarkReportProvenance;
  readonly query_count: number;
  readonly top3_accuracy: number;
  readonly constraint_compliance_rate: number;
  readonly min_pass_rate: number;
  readonly failures: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly expected_constraints_summary: readonly string[];
    readonly top_entity_id: string | null;
    readonly top_k_entities: readonly string[];
    readonly constraint_violation_reason: string | null;
  }[];
  readonly evaluated_at: string;
}

export interface SearchFeatureBehaviorCorpusGovernanceSummary {
  readonly queryCount: number;
  readonly categoryMix: Readonly<Record<string, number>>;
  readonly difficultyMix: Readonly<Record<string, number>>;
  readonly languageMix: Readonly<Record<string, number>>;
  readonly evaluationModeMix: Readonly<Record<string, number>>;
  readonly targetEntityCaseCount: number;
  readonly constraintBearingCaseCount: number;
  readonly entityShareTop: readonly {
    readonly entityId: string;
    readonly count: number;
    readonly share: number;
  }[];
}

interface SearchFeatureBehaviorCorpusGovernanceOptions {
  readonly minQueryCount?: number;
  readonly minDistinctCategories?: number;
  readonly minDistinctDifficulties?: number;
  readonly minTargetEntityCases?: number;
  readonly minConstraintBearingCases?: number;
  readonly maxEntityShare?: number;
}

// ─── Concurrency pool ───────────────────────────────────────────────────────

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }

  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

// ─── Arg parser ─────────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): CliArgs {
  let output = DEFAULT_OUTPUT;
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';
  let timeoutMs = 60_000;
  let concurrency = DEFAULT_CONCURRENCY;
  let executionLane: BenchmarkExecutionLane = 'trusted_benchmark';
  let runtimeTarget: SearchFeatureBehaviorRuntimeTarget = 'http';
  let debugKey = process.env['BENCHMARK_DEBUG_KEY'] ?? process.env['HTTP_DEBUG_SECRET'];
  let useThresholds = true;
  let smokePredictions = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' || arg === '-o') {
      output = resolveCliDataPathArg(argv[++i] ?? output);
    } else if (arg === '--api-url') {
      apiUrl = argv[++i] ?? apiUrl;
    } else if (arg === '--timeout-ms') {
      const v = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(v) && v >= 1000) timeoutMs = v;
    } else if (arg === '--concurrency') {
      const v = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(v) && v >= 1) concurrency = Math.min(16, v);
    } else if (arg === '--execution-lane') {
      const value = argv[++i];
      if (value === 'public' || value === 'trusted_benchmark') {
        executionLane = value;
      }
    } else if (arg === '--runtime-target') {
      const value = argv[++i];
      if (value === 'http' || value === 'inprocess') {
        runtimeTarget = value;
      }
    } else if (arg === '--debug-key') {
      debugKey = argv[++i] ?? debugKey;
    } else if (arg === '--no-thresholds') {
      useThresholds = false;
    } else if (arg === '--smoke-predictions') {
      smokePredictions = true;
    }
  }

  return {
    output,
    apiUrl,
    timeoutMs,
    concurrency,
    executionLane,
    runtimeTarget,
    debugKey,
    useThresholds,
    smokePredictions,
  };
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

// ─── Fixture case adapter ────────────────────────────────────────────────────

function adaptCase(raw: unknown): SearchFeatureBehaviorCase {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid fixture case: not an object');
  }
  const c = raw as Record<string, unknown>;
  const evaluation = c['evaluation'] as Record<string, unknown> | undefined;
  if (typeof evaluation !== 'object' || evaluation === null) {
    throw new Error(`Fixture case ${String(c['id'])} is missing evaluation`);
  }

  // expected_constraints_summary: derived from evaluation fields available in
  // search_feature_behavior suite (attribute-driven cases carry constraint metadata).
  const constraintsSummary: string[] = [];
  const tags = c['tags'];
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string' && tag.startsWith('constraint:')) {
        constraintsSummary.push(tag.slice('constraint:'.length));
      }
    }
  }

  return {
    benchmark_id: String(c['id'] ?? ''),
    query: String(c['query'] ?? ''),
    category: String(c['category'] ?? ''),
    language: (c['language'] as 'ko' | 'en' | 'mixed') ?? 'en',
    difficulty: (c['difficulty'] as 'easy' | 'medium' | 'hard') ?? 'medium',
    top_k: typeof evaluation['top_k'] === 'number' ? evaluation['top_k'] : 3,
    evaluation_mode: typeof evaluation['mode'] === 'string' ? evaluation['mode'] : '',
    target_entity_id:
      typeof evaluation['target_entity_id'] === 'string'
        ? evaluation['target_entity_id']
        : undefined,
    expected_constraints_summary: constraintsSummary,
    answer_must_match: extractStringArray(evaluation['answer_must_match']),
    answer_must_not_match: extractStringArray(evaluation['answer_must_not_match']),
  };
}

export function summarizeSearchFeatureBehaviorCorpusGovernance(
  cases: readonly SearchFeatureBehaviorCase[],
): SearchFeatureBehaviorCorpusGovernanceSummary {
  const entityCounts = new Map<string, number>();
  for (const benchmarkCase of cases) {
    const entityId = benchmarkCase.target_entity_id;
    if (entityId === undefined) continue;
    entityCounts.set(entityId, (entityCounts.get(entityId) ?? 0) + 1);
  }
  return {
    queryCount: cases.length,
    categoryMix: countBy(cases.map((benchmarkCase) => benchmarkCase.category)),
    difficultyMix: countBy(cases.map((benchmarkCase) => benchmarkCase.difficulty)),
    languageMix: countBy(cases.map((benchmarkCase) => benchmarkCase.language)),
    evaluationModeMix: countBy(cases.map((benchmarkCase) => benchmarkCase.evaluation_mode)),
    targetEntityCaseCount: cases.filter((benchmarkCase) => benchmarkCase.target_entity_id !== undefined).length,
    constraintBearingCaseCount: cases.filter((benchmarkCase) =>
      benchmarkCase.expected_constraints_summary.length > 0
      || benchmarkCase.answer_must_not_match.length > 0,
    ).length,
    entityShareTop: [...entityCounts.entries()]
      .map(([entityId, count]) => ({
        entityId,
        count,
        share: count / Math.max(1, cases.length),
      }))
      .sort((left, right) => right.share - left.share || left.entityId.localeCompare(right.entityId))
      .slice(0, 10),
  };
}

export function validateSearchFeatureBehaviorCorpusGovernance(
  cases: readonly SearchFeatureBehaviorCase[],
  options: SearchFeatureBehaviorCorpusGovernanceOptions = {},
): SearchFeatureBehaviorCorpusGovernanceSummary {
  const summary = summarizeSearchFeatureBehaviorCorpusGovernance(cases);
  const minQueryCount = options.minQueryCount ?? MIN_SFB_QUERY_COUNT;
  const minDistinctCategories = options.minDistinctCategories ?? MIN_SFB_DISTINCT_CATEGORIES;
  const minDistinctDifficulties = options.minDistinctDifficulties ?? MIN_SFB_DISTINCT_DIFFICULTIES;
  const minTargetEntityCases = options.minTargetEntityCases ?? MIN_SFB_TARGET_ENTITY_CASES;
  const minConstraintBearingCases = options.minConstraintBearingCases ?? MIN_SFB_CONSTRAINT_BEARING_CASES;
  const maxEntityShare = options.maxEntityShare ?? MAX_SFB_ENTITY_SHARE;
  const violations: string[] = [];

  if (summary.queryCount < minQueryCount) {
    violations.push(`query_count=${summary.queryCount} < minimum ${minQueryCount}`);
  }

  if (Object.keys(summary.categoryMix).length < minDistinctCategories) {
    violations.push(
      `distinct_categories=${Object.keys(summary.categoryMix).length} < minimum ${minDistinctCategories}`,
    );
  }

  if (Object.keys(summary.difficultyMix).length < minDistinctDifficulties) {
    violations.push(
      `distinct_difficulties=${Object.keys(summary.difficultyMix).length} < minimum ${minDistinctDifficulties}`,
    );
  }

  if ((summary.languageMix['ko'] ?? 0) === 0) {
    violations.push('language_mix missing ko cases');
  }

  if (summary.targetEntityCaseCount < minTargetEntityCases) {
    violations.push(
      `target_entity_case_count=${summary.targetEntityCaseCount} < minimum ${minTargetEntityCases}`,
    );
  }

  if (summary.constraintBearingCaseCount < minConstraintBearingCases) {
    violations.push(
      `constraint_bearing_case_count=${summary.constraintBearingCaseCount} < minimum ${minConstraintBearingCases}`,
    );
  }

  const overCap = summary.entityShareTop.filter((entry) => entry.share > maxEntityShare);
  if (overCap.length > 0) {
    violations.push(
      `entity_share_cap_exceeded: ${overCap
        .map((entry) => `${entry.entityId} ${(entry.share * 100).toFixed(2)}% (${entry.count}/${summary.queryCount})`)
        .join(', ')}`,
    );
  }

  const unsupportedModes = [...new Set(
    cases
      .map((benchmarkCase) => benchmarkCase.evaluation_mode)
      .filter((mode) => !SUPPORTED_SFB_EVALUATION_MODES.includes(mode as (typeof SUPPORTED_SFB_EVALUATION_MODES)[number])),
  )];
  if (unsupportedModes.length > 0) {
    violations.push(`unsupported evaluation modes: ${unsupportedModes.join(', ')}`);
  }

  if (violations.length > 0) {
    throw new Error(`search_feature_behavior corpus governance failed:\n- ${violations.join('\n- ')}`);
  }

  return summary;
}

// ─── Live API call ────────────────────────────────────────────────────────────

async function callSearchApi(
  apiUrl: string,
  query: string,
  timeoutMs: number,
  executionLane: BenchmarkExecutionLane,
  debugKey?: string,
): Promise<LiveSearchResponse> {
  const response = await fetch(resolveBenchmarkSearchEndpoint(apiUrl, executionLane), {
    method: 'POST',
    headers: buildBenchmarkRequestHeaders(executionLane, debugKey),
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return { results: [] };
  }
  const body = (await response.json()) as unknown;
  return extractSearchResponse(body);
}

async function createInProcessSearchCaller(): Promise<InProcessSearchCaller> {
  const container = await createContainer(config);
  let requestSequence = 0;

  return {
    execute: async (query: string, timeoutMs: number): Promise<LiveSearchResponse> => {
      requestSequence += 1;
      const response = await container.searchUseCase.execute(
        { query },
        `sfb-inprocess-${requestSequence}`,
        {
          executionPrincipal: 'benchmark_trusted',
          abortSignal: AbortSignal.timeout(timeoutMs),
        },
      );
      return extractSearchResponseFromUseCaseResponse(response);
    },
    close: async (): Promise<void> => {
      // Pool ownership is closed once at runner shutdown after persistence.
    },
  };
}

function extractSearchResponse(body: unknown): LiveSearchResponse {
  if (typeof body !== 'object' || body === null) return { results: [] };
  const b = body as Record<string, unknown>;
  const rawResults = b['results'];
  if (!Array.isArray(rawResults)) return { results: [], decision_status: String(b['decision_status'] ?? '') };

  const results: SearchResultItem[] = [];
  for (const raw of rawResults) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;

    // constraints is a required field in SearchResultSchema — always present.
    // violated_constraints and match_reasons are optional.
    const rawConstraints = r['constraints'];
    const constraints =
      typeof rawConstraints === 'object' && rawConstraints !== null
        ? {
            matched: extractStringArray((rawConstraints as Record<string, unknown>)['matched']),
            unmet: extractStringArray((rawConstraints as Record<string, unknown>)['unmet']),
            inferred: extractStringArray((rawConstraints as Record<string, unknown>)['inferred']),
          }
        : { matched: [], unmet: [], inferred: [] };

    const entityObj = r['entity'];
    const entityId =
      typeof entityObj === 'object' && entityObj !== null
        ? String((entityObj as Record<string, unknown>)['entity_id'] ?? '')
        : '';
    const canonicalLabel =
      typeof entityObj === 'object' && entityObj !== null
        ? String((entityObj as Record<string, unknown>)['canonical_label'] ?? '')
        : '';
    const wineType =
      typeof entityObj === 'object' && entityObj !== null
      && typeof (entityObj as Record<string, unknown>)['wine_type'] === 'string'
        ? String((entityObj as Record<string, unknown>)['wine_type'])
        : undefined;
    const style =
      typeof entityObj === 'object' && entityObj !== null
      && typeof (entityObj as Record<string, unknown>)['style'] === 'string'
        ? String((entityObj as Record<string, unknown>)['style'])
        : undefined;

    results.push({
      entity_id: entityId,
      canonical_label: canonicalLabel,
      wine_type: wineType,
      style,
      constraints,
      violated_constraints: extractStringArray(r['violated_constraints']) ?? undefined,
      match_reasons: extractStringArray(r['match_reasons']) ?? undefined,
    });
  }
  return { results, decision_status: typeof b['decision_status'] === 'string' ? b['decision_status'] : undefined };
}

export function extractSearchResponseFromUseCaseResponse(
  response: SearchResponseV1 | ComparisonSearchResponse,
): LiveSearchResponse {
  if (response.queryType !== 'search') {
    return { results: [], decision_status: undefined };
  }

  return {
    decision_status: response.engineDecision.decisionStatus,
    results: response.results.map((result) => ({
      entity_id: result.entity.entityId,
      canonical_label: result.entity.canonicalLabel,
      wine_type: result.entity.wineType,
      style: result.entity.style,
      constraints: {
        matched: result.constraints.matched,
        unmet: result.constraints.unmet,
        inferred: result.constraints.inferred,
      },
      violated_constraints: result.violatedConstraints,
      match_reasons: result.matchReasons,
    })),
  };
}

function extractStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

// ─── Smoke prediction synthesizer ────────────────────────────────────────────

/**
 * Smoke mode: synthesizes fixture-derived deterministic predictions.
 * No live API call — structural verification only.
 * ADR-005 §3: smoke predictions come from fixture truth, no hidden benchmark truth.
 */
function synthesizeSmokeResponse(benchmarkCase: SearchFeatureBehaviorCase): LiveSearchResponse {
  const targetId = benchmarkCase.target_entity_id ?? `smoke-entity-${benchmarkCase.benchmark_id}`;
  const matchReasons =
    benchmarkCase.evaluation_mode === 'answer_rubric'
      ? benchmarkCase.answer_must_match.slice()
      : undefined;
  return {
    results: [
      {
        entity_id: targetId,
        canonical_label: targetId,
        constraints: { matched: benchmarkCase.expected_constraints_summary.slice(), unmet: [], inferred: [] },
        violated_constraints: undefined,
        match_reasons: matchReasons,
      },
    ],
    decision_status: 'resolved',
  };
}

function compilePatterns(patterns: readonly string[]): readonly RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, 'iu'));
}

function matchesAnyPattern(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function buildResultEvaluationText(result: SearchResultItem): string {
  return [
    result.canonical_label,
    result.wine_type,
    result.style,
    ...(result.match_reasons ?? []),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

// ─── Case evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluates a single case result.
 *
 * Constraint compliance logic (ADR-005 Workstream A, Execution logic 4):
 * 1. Primary source: results[*].constraints.unmet (required field, always present)
 * 2. Supplementary: results[*].violated_constraints (optional, string diagnostic)
 *
 * If constraints.unmet is non-empty for the top-1 result, the case fails
 * constraint compliance. If constraints field is structurally absent (schema
 * regression), runner fails closed — not counted as compliant.
 */
export function evaluateCase(
  benchmarkCase: SearchFeatureBehaviorCase,
  response: LiveSearchResponse,
): CaseResult {
  const topK = benchmarkCase.top_k;
  const topKResults = response.results.slice(0, topK);
  const topKEntities = topKResults.map((r) => r.entity_id);
  const topEntityId = topKEntities[0] ?? null;

  const exactEntityTopKHit =
    benchmarkCase.target_entity_id !== undefined
      ? topKEntities.includes(benchmarkCase.target_entity_id)
      : true;

  let topKHit = exactEntityTopKHit;
  const topResult = response.results[0];
  let constraintCompliant = true;
  let constraintViolationReason: string | null = null;

  if (benchmarkCase.evaluation_mode === 'answer_rubric') {
    const positivePatterns = compilePatterns(benchmarkCase.answer_must_match);
    const negativePatterns = compilePatterns(benchmarkCase.answer_must_not_match);
    const topKTexts = topKResults.map(buildResultEvaluationText);
    const topResultText = topResult === undefined ? '' : buildResultEvaluationText(topResult);

    topKHit = positivePatterns.length === 0
      ? topKResults.length > 0
      : topKTexts.some((text) => matchesAnyPattern(text, positivePatterns));

    if (topResult === undefined) {
      constraintCompliant = false;
      constraintViolationReason = 'No results returned for answer_rubric case.';
    } else if (negativePatterns.length > 0 && matchesAnyPattern(topResultText, negativePatterns)) {
      constraintCompliant = false;
      constraintViolationReason = 'Top result matched forbidden answer_rubric pattern.';
    } else if (!topKHit) {
      constraintViolationReason = `No top-${topK} result matched required answer_rubric pattern.`;
    }
  } else if (topResult === undefined) {
    if (benchmarkCase.expected_constraints_summary.length > 0) {
      constraintCompliant = false;
      constraintViolationReason = 'No results returned; expected constraint-matching results.';
    }
  } else {
    const unmet = topResult.constraints.unmet;
    if (unmet.length > 0) {
      constraintCompliant = false;
      constraintViolationReason = `Top result has ${unmet.length} unmet constraint(s): ${unmet.slice(0, 3).join(', ')}`;
    } else if ((topResult.violated_constraints?.length ?? 0) > 0) {
      constraintCompliant = false;
      constraintViolationReason = `violated_constraints: ${topResult.violated_constraints!.slice(0, 3).join(', ')}`;
    }
  }

  const pass = topKHit && constraintCompliant;

  return {
    benchmark_id: benchmarkCase.benchmark_id,
    query: benchmarkCase.query,
    pass,
    topKHit,
    constraintCompliant,
    top_entity_id: topEntityId,
    top_k_entities: topKEntities,
    expected_constraints_summary: benchmarkCase.expected_constraints_summary,
    constraint_violation_reason: constraintViolationReason,
  };
}

// ─── Report builder ───────────────────────────────────────────────────────────

export function buildSearchFeatureBehaviorReport(
  results: readonly CaseResult[],
  executionLane: BenchmarkExecutionLane = 'trusted_benchmark',
): SearchFeatureBehaviorFixtureReport {
  const count = results.length;
  const failures = results
    .filter((r) => !r.pass)
    .slice(0, MAX_FAILURES_IN_REPORT)
    .map((r) => ({
      benchmark_id: r.benchmark_id,
      query: r.query,
      expected_constraints_summary: r.expected_constraints_summary,
      top_entity_id: r.top_entity_id,
      top_k_entities: r.top_k_entities,
      constraint_violation_reason: r.constraint_violation_reason,
    }));

  const top3Accuracy = count === 0 ? 0 : results.filter((r) => r.topKHit).length / count;
  const constraintComplianceRate =
    count === 0 ? 0 : results.filter((r) => r.constraintCompliant).length / count;
  const minPassRate = count === 0 ? 0 : results.filter((r) => r.pass).length / count;

  return {
    benchmark: 'search-feature-behavior-fixture',
    suite_id: SUITE_ID,
    execution_lane: executionLane,
    query_count: count,
    top3_accuracy: top3Accuracy,
    constraint_compliance_rate: constraintComplianceRate,
    min_pass_rate: minPassRate,
    failures,
    evaluated_at: new Date().toISOString(),
  };
}

// ─── Threshold assertion ──────────────────────────────────────────────────────

async function assertThresholds(report: SearchFeatureBehaviorFixtureReport): Promise<void> {
  const thresholds = await loadFixtureThresholds();
  const suiteThresholds = thresholds[SUITE_ID];
  if (typeof suiteThresholds !== 'object' || suiteThresholds === null) return;
  const record = suiteThresholds as Readonly<Record<string, unknown>>;
  const violations: string[] = [];

  const top3Accuracy = readNumericThreshold(record, 'top3_accuracy');
  if (top3Accuracy !== undefined && report.top3_accuracy < top3Accuracy) {
    violations.push(
      `top3_accuracy=${report.top3_accuracy.toFixed(4)} < threshold ${top3Accuracy.toFixed(4)}`,
    );
  }

  const constraintCompliance = readNumericThreshold(record, 'constraint_compliance_rate');
  if (constraintCompliance !== undefined && report.constraint_compliance_rate < constraintCompliance) {
    violations.push(
      `constraint_compliance_rate=${report.constraint_compliance_rate.toFixed(4)} < threshold ${constraintCompliance.toFixed(4)}`,
    );
  }

  const minPassRate = readNumericThreshold(record, 'min_pass_rate');
  if (minPassRate !== undefined && report.min_pass_rate < minPassRate) {
    violations.push(
      `min_pass_rate=${report.min_pass_rate.toFixed(4)} < threshold ${minPassRate.toFixed(4)}`,
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `search_feature_behavior fixture gate failed:\n- ${violations.join('\n- ')}`,
    );
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rawCases = await loadFixtureCases([SUITE_ID]);
  const cases = rawCases.map(adaptCase);
  const governanceSummary = validateSearchFeatureBehaviorCorpusGovernance(cases);
  process.stderr.write(
    `[sfb-fixture-eval] corpus_governance cases=${governanceSummary.queryCount} categories=${Object.keys(governanceSummary.categoryMix).length} difficulties=${Object.keys(governanceSummary.difficultyMix).length} target_cases=${governanceSummary.targetEntityCaseCount} constraint_bearing=${governanceSummary.constraintBearingCaseCount}\n`,
  );
  if (!args.smokePredictions && args.runtimeTarget === 'http') {
    await runLiveBenchmarkPreflight({
      apiUrl: args.apiUrl,
      executionLane: args.executionLane,
      debugKey: args.debugKey,
      requiredEntityIds: cases
        .map((benchmarkCase) => benchmarkCase.target_entity_id)
        .filter((entityId): entityId is string => entityId !== undefined),
    });
  }

  process.stderr.write(
    `[sfb-fixture-eval] ${args.smokePredictions ? 'smoke' : args.runtimeTarget} — ${cases.length} cases\n`,
  );

  const inProcessCaller =
    !args.smokePredictions && args.runtimeTarget === 'inprocess'
      ? await createInProcessSearchCaller()
      : undefined;
  try {
    const results = await mapPool(cases, args.concurrency, async (benchmarkCase) => {
      const response = args.smokePredictions
        ? synthesizeSmokeResponse(benchmarkCase)
        : args.runtimeTarget === 'inprocess'
          ? await inProcessCaller!.execute(benchmarkCase.query, args.timeoutMs)
          : await callSearchApi(
              args.apiUrl,
              benchmarkCase.query,
              args.timeoutMs,
              args.executionLane,
              args.debugKey,
            );
      return evaluateCase(benchmarkCase, response);
    });

    const report = buildSearchFeatureBehaviorReport(results, args.executionLane);

    // Check thresholds, capturing pass/fail before persisting
    let thresholdsPassed = true;
    let thresholdError: unknown;
    if (args.useThresholds) {
      try {
        await assertThresholds(report);
      } catch (err: unknown) {
        thresholdsPassed = false;
        thresholdError = err;
      }
    }

    const benchmarkKind = args.smokePredictions
      ? 'search_feature_behavior_structural'
      : args.runtimeTarget === 'inprocess'
        ? 'search_feature_behavior_fixture'
        : 'search_feature_behavior_live';
    const featureSchemaHash = getCurrentFeatureSchemaHash();
    const runtimeMetadata = args.smokePredictions || args.runtimeTarget === 'inprocess'
      ? undefined
      : await collectLiveBenchmarkRuntimeMetadata(args.apiUrl);
    const languageMix = countStringMix(cases.map((benchmarkCase) => benchmarkCase.language));
    const storeProvenance = {
      provenanceSchemaVersion: 1 as const,
      corpusId: 'fixture:search_feature_behavior',
      corpusHash: hashStableJson(rawCases),
      runtimeTarget: args.smokePredictions
        ? 'fixture_structural_predictions'
        : args.runtimeTarget === 'inprocess'
          ? 'search_usecase_inprocess'
          : 'search_api_http',
      usesLiveApi: !args.smokePredictions && args.runtimeTarget === 'http',
      smokeSynthesized: args.smokePredictions,
      thresholdSource: args.useThresholds ? 'external_fixture_thresholds' : 'thresholds_disabled',
      gateEligible: args.useThresholds && (
        args.smokePredictions
          ? false
          : args.runtimeTarget === 'inprocess'
            ? true
            : runtimeMetadata?.readinessPassed === true
      ),
      suiteGatePassed: thresholdsPassed,
      ...(runtimeMetadata?.searchSnapshotId !== undefined
        ? { searchSnapshotId: runtimeMetadata.searchSnapshotId }
        : {}),
      ...(runtimeMetadata?.runtimeActivationStatus !== undefined
        ? { runtimeActivationStatus: runtimeMetadata.runtimeActivationStatus }
        : {}),
      ...(runtimeMetadata?.readinessPassed !== undefined
        ? { readinessPassed: runtimeMetadata.readinessPassed }
        : {}),
      ...(runtimeMetadata?.activeLtrModels !== undefined
        ? { activeLtrModels: runtimeMetadata.activeLtrModels }
        : {}),
      ...(languageMix !== undefined
        ? { sliceMix: languageMix }
        : {}),
    };
    const finalReport: SearchFeatureBehaviorFixtureReport = {
      ...report,
      provenance: toReportProvenance({
        benchmarkKind,
        provenance: storeProvenance,
        featureSchemaHash,
      }),
    };

    await fs.writeFile(args.output, JSON.stringify(finalReport, null, 2), 'utf8');
    process.stderr.write(`[sfb-fixture-eval] wrote ${args.output}\n`);
    process.stderr.write(
      `[sfb-fixture-eval] top3=${finalReport.top3_accuracy.toFixed(4)} constraint_compliance=${finalReport.constraint_compliance_rate.toFixed(4)} pass_rate=${finalReport.min_pass_rate.toFixed(4)}\n`,
    );

    try {
      const { getPgPool } = await import('../../src/infrastructure/db/pg-pool.js');
      const pool = getPgPool();
      const evalBenchmarkRunStore = new PgEvalBenchmarkRunStore(pool);
      await evalBenchmarkRunStore.saveRun({
        benchmarkKind,
        evalDatasetVersion: storeProvenance.corpusId,
        featureSchemaHash,
        queryCount: finalReport.query_count,
        recallAt3: finalReport.top3_accuracy,
        provenance: storeProvenance,
        report: finalReport as unknown as Readonly<Record<string, unknown>>,
        metrics: {
          retrieval_accuracy: finalReport.top3_accuracy,
          constraint_compliance: finalReport.constraint_compliance_rate,
          pass_rate: finalReport.min_pass_rate,
        },
      });
      process.stderr.write('[sfb-fixture-eval] Benchmark run persisted to DB.\n');
    } catch (persistErr: unknown) {
      const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      process.stderr.write(`[sfb-fixture-eval] [WARN] Could not persist benchmark run to DB: ${msg}\n`);
    }

    if (thresholdError !== undefined) {
      throw thresholdError;
    }
  } finally {
    await inProcessCaller?.close();
    await closePgPool().catch(() => undefined);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[sfb-fixture-eval] fatal: ${message}\n`);
    process.exit(1);
  });
}
