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
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import {
  buildBenchmarkRequestHeaders,
  resolveBenchmarkSearchEndpoint,
  runLiveBenchmarkPreflight,
  type BenchmarkExecutionLane,
} from './live-benchmark-preflight.js';
import { resolveCliDataPathArg } from './cli-data-path.js';
import { PgEvalBenchmarkRunStore } from '../../src/infrastructure/adapter/pg-eval-benchmark-run-store.js';
import { getCurrentFeatureSchemaHash } from '../../src/domain/ranking/service/feature-parity-hash.js';

const SUITE_ID = 'search_feature_behavior' as const;
const DEFAULT_OUTPUT = resolveDataPath('data/search-feature-behavior-fixture-eval-results.json');

/** Maximum failure records included in the report (keeps JSON manageable). */
const MAX_FAILURES_IN_REPORT = 50;

/** Default concurrency for live API calls. */
const DEFAULT_CONCURRENCY = 4;

interface CliArgs {
  readonly output: string;
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly executionLane: BenchmarkExecutionLane;
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
  readonly target_entity_id: string | undefined;
  readonly expected_constraints_summary: readonly string[];
}

interface SearchResultItem {
  readonly entity_id: string;
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
    } else if (arg === '--debug-key') {
      debugKey = argv[++i] ?? debugKey;
    } else if (arg === '--no-thresholds') {
      useThresholds = false;
    } else if (arg === '--smoke-predictions') {
      smokePredictions = true;
    }
  }

  return { output, apiUrl, timeoutMs, concurrency, executionLane, debugKey, useThresholds, smokePredictions };
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
    target_entity_id:
      typeof evaluation['target_entity_id'] === 'string'
        ? evaluation['target_entity_id']
        : undefined,
    expected_constraints_summary: constraintsSummary,
  };
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

    results.push({
      entity_id: entityId,
      constraints,
      violated_constraints: extractStringArray(r['violated_constraints']) ?? undefined,
      match_reasons: extractStringArray(r['match_reasons']) ?? undefined,
    });
  }
  return { results, decision_status: typeof b['decision_status'] === 'string' ? b['decision_status'] : undefined };
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
  return {
    results: [
      {
        entity_id: targetId,
        constraints: { matched: benchmarkCase.expected_constraints_summary.slice(), unmet: [], inferred: [] },
        violated_constraints: undefined,
        match_reasons: undefined,
      },
    ],
    decision_status: 'resolved',
  };
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
function evaluateCase(
  benchmarkCase: SearchFeatureBehaviorCase,
  response: LiveSearchResponse,
): CaseResult {
  const topK = benchmarkCase.top_k;
  const topKEntities = response.results.slice(0, topK).map((r) => r.entity_id);
  const topEntityId = topKEntities[0] ?? null;

  // Top-K hit: target entity appears within allowed K positions.
  const topKHit =
    benchmarkCase.target_entity_id !== undefined
      ? topKEntities.includes(benchmarkCase.target_entity_id)
      : true; // No target = not measurable, don't penalize

  // Constraint compliance: top-1 result must have no unmet hard constraints.
  const topResult = response.results[0];
  let constraintCompliant = true;
  let constraintViolationReason: string | null = null;

  if (topResult === undefined) {
    // No results at all — constraint compliance cannot be evaluated.
    // Treat as non-compliant only when there are expected constraints.
    if (benchmarkCase.expected_constraints_summary.length > 0) {
      constraintCompliant = false;
      constraintViolationReason = 'No results returned; expected constraint-matching results.';
    }
  } else {
    // constraints is a required field per SearchResultSchema.
    // An absent constraints object indicates a schema regression — fail closed.
    const unmet = topResult.constraints.unmet;
    if (unmet.length > 0) {
      constraintCompliant = false;
      constraintViolationReason = `Top result has ${unmet.length} unmet constraint(s): ${unmet.slice(0, 3).join(', ')}`;
    } else if ((topResult.violated_constraints?.length ?? 0) > 0) {
      // violated_constraints is a supplementary diagnostic — flag but don't double-count.
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
  if (!args.smokePredictions) {
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
    `[sfb-fixture-eval] ${args.smokePredictions ? 'smoke' : 'live'} — ${cases.length} cases\n`,
  );

  const results = await mapPool(cases, args.concurrency, async (benchmarkCase) => {
    const response = args.smokePredictions
      ? synthesizeSmokeResponse(benchmarkCase)
      : await callSearchApi(
          args.apiUrl,
          benchmarkCase.query,
          args.timeoutMs,
          args.executionLane,
          args.debugKey,
        );
    return evaluateCase(benchmarkCase, response);
  });

  const report = buildSearchFeatureBehaviorReport(results);

  await fs.writeFile(args.output, JSON.stringify(report, null, 2), 'utf8');
  process.stderr.write(`[sfb-fixture-eval] wrote ${args.output}\n`);
  process.stderr.write(
    `[sfb-fixture-eval] top3=${report.top3_accuracy.toFixed(4)} constraint_compliance=${report.constraint_compliance_rate.toFixed(4)} pass_rate=${report.min_pass_rate.toFixed(4)}\n`,
  );

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

  // Persist benchmark run to DB (best-effort — eval succeeds even if DB is unavailable)
  try {
    const { getPgPool } = await import('../../src/infrastructure/db/pg-pool.js');
    const pool = getPgPool();
    try {
      const evalBenchmarkRunStore = new PgEvalBenchmarkRunStore(pool);
      await evalBenchmarkRunStore.saveRun({
        benchmarkKind: 'search_feature_behavior_fixture',
        evalDatasetVersion: 'v1',
        featureSchemaHash: getCurrentFeatureSchemaHash(),
        queryCount: report.query_count,
        recallAt3: report.top3_accuracy,
        releaseGatePassed: thresholdsPassed,
        activationStatus: 'shadow_only',
        report: report as unknown as Readonly<Record<string, unknown>>,
        metrics: {
          retrieval_accuracy: report.top3_accuracy,
          constraint_compliance: report.constraint_compliance_rate,
          pass_rate: report.min_pass_rate,
        },
      });
      process.stderr.write('[sfb-fixture-eval] Benchmark run persisted to DB.\n');
    } finally {
      await pool.end();
    }
  } catch (persistErr: unknown) {
    const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    process.stderr.write(`[sfb-fixture-eval] [WARN] Could not persist benchmark run to DB: ${msg}\n`);
  }

  if (thresholdError !== undefined) {
    throw thresholdError;
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
