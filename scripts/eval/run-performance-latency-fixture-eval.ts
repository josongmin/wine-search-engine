#!/usr/bin/env tsx
/**
 * Fixture-native performance_latency benchmark runner.
 * ADR-005 Workstream B.
 *
 * Evaluates per-case latency SLOs defined in the external fixture suite.
 * SLO thresholds (p50/p95/p99) come from external thresholds.json — no
 * hardcoded constants in this runner.
 *
 * Usage:
 *   npx tsx scripts/eval/run-performance-latency-fixture-eval.ts
 *   npx tsx scripts/eval/run-performance-latency-fixture-eval.ts \
 *     --output data/perf-latency-results.json --api-url http://localhost:3000
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();
import fs from 'node:fs/promises';

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

const SUITE_ID = 'performance_latency' as const;
const DEFAULT_OUTPUT = resolveDataPath('data/performance-latency-fixture-eval-results.json');

/** Maximum failure records included in the report. */
const MAX_FAILURES_IN_REPORT = 50;

/** Default warm-up request count before measurement. */
const DEFAULT_WARMUP = 2;

/** Default concurrency for latency measurements (serial by default — P99 is meaningful). */
const DEFAULT_CONCURRENCY = 1;

interface CliArgs {
  readonly output: string;
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly warmup: number;
  readonly executionLane: BenchmarkExecutionLane;
  readonly debugKey?: string;
  readonly useThresholds: boolean;
}

interface LatencyCase {
  readonly benchmark_id: string;
  readonly query: string;
  readonly category: string;
  readonly slo_p50_ms: number | undefined;
  readonly slo_p95_ms: number | undefined;
  readonly slo_p99_ms: number | undefined;
}

interface CaseLatencyResult {
  readonly benchmark_id: string;
  readonly query: string;
  readonly duration_ms: number;
  readonly slo_p95_ms: number | undefined;
  readonly pass: boolean;
  readonly violation_reason: string | null;
}

/** Required output report shape (ADR-005 Workstream B). */
export interface PerformanceLatencyFixtureReport {
  readonly benchmark: 'performance-latency-fixture';
  readonly suite_id: 'performance_latency';
  readonly query_count: number;
  readonly slo_pass_rate: number;
  readonly latency_summary: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };
  readonly min_pass_rate: number;
  readonly failures: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly duration_ms: number;
    readonly slo_p95_ms: number | undefined;
    readonly violation_reason: string | null;
  }[];
  readonly evaluated_at: string;
}

// ─── Arg parser ──────────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): CliArgs {
  let output = DEFAULT_OUTPUT;
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';
  let timeoutMs = 30_000;
  let concurrency = DEFAULT_CONCURRENCY;
  let warmup = DEFAULT_WARMUP;
  let executionLane: BenchmarkExecutionLane = 'trusted_benchmark';
  let debugKey = process.env['BENCHMARK_DEBUG_KEY'] ?? process.env['HTTP_DEBUG_SECRET'];
  let useThresholds = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' || arg === '-o') {
      output = resolveCliDataPathArg(argv[++i] ?? output);
    } else if (arg === '--api-url') {
      apiUrl = argv[++i] ?? apiUrl;
    } else if (arg === '--timeout-ms') {
      const v = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(v) && v >= 100) timeoutMs = v;
    } else if (arg === '--concurrency') {
      const v = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(v) && v >= 1) concurrency = Math.min(16, v);
    } else if (arg === '--warmup') {
      const v = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(v) && v >= 0) warmup = v;
    } else if (arg === '--execution-lane') {
      const value = argv[++i];
      if (value === 'public' || value === 'trusted_benchmark') {
        executionLane = value;
      }
    } else if (arg === '--debug-key') {
      debugKey = argv[++i] ?? debugKey;
    } else if (arg === '--no-thresholds') {
      useThresholds = false;
    }
  }

  return { output, apiUrl, timeoutMs, concurrency, warmup, executionLane, debugKey, useThresholds };
}

// ─── Fixture case adapter ────────────────────────────────────────────────────

function adaptCase(raw: unknown): LatencyCase {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid fixture case: not an object');
  }
  const c = raw as Record<string, unknown>;
  const evaluation = c['evaluation'] as Record<string, unknown> | undefined;
  if (typeof evaluation !== 'object' || evaluation === null) {
    throw new Error(`Fixture case ${String(c['id'])} is missing evaluation`);
  }

  // SLO values come from evaluation.latency_slo_ms defined in BenchmarkCase schema.
  const sloObj = evaluation['latency_slo_ms'];
  const slo =
    typeof sloObj === 'object' && sloObj !== null
      ? (sloObj as Record<string, unknown>)
      : {};

  return {
    benchmark_id: String(c['id'] ?? ''),
    query: String(c['query'] ?? ''),
    category: String(c['category'] ?? ''),
    slo_p50_ms: typeof slo['p50'] === 'number' ? slo['p50'] : undefined,
    slo_p95_ms: typeof slo['p95'] === 'number' ? slo['p95'] : undefined,
    slo_p99_ms: typeof slo['p99'] === 'number' ? slo['p99'] : undefined,
  };
}

// ─── Live execution ───────────────────────────────────────────────────────────

async function measureLatency(
  apiUrl: string,
  query: string,
  timeoutMs: number,
  executionLane: BenchmarkExecutionLane,
  debugKey?: string,
): Promise<number> {
  const start = performance.now();
  const response = await fetch(resolveBenchmarkSearchEndpoint(apiUrl, executionLane), {
    method: 'POST',
    headers: buildBenchmarkRequestHeaders(executionLane, debugKey),
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Drain body to get true end-to-end wall clock.
  await response.text();
  return performance.now() - start;
}

async function warmUp(
  apiUrl: string,
  warmupCount: number,
  timeoutMs: number,
  executionLane: BenchmarkExecutionLane,
  debugKey?: string,
): Promise<void> {
  for (let i = 0; i < warmupCount; i++) {
    try {
      await measureLatency(apiUrl, 'Opus One', timeoutMs, executionLane, debugKey);
    } catch {
      // Warm-up failures are ignored — we just want JIT and connection pool warm.
    }
  }
}

// ─── Concurrency pool ─────────────────────────────────────────────────────────

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

// ─── Case evaluator ───────────────────────────────────────────────────────────

function evaluateCase(benchmarkCase: LatencyCase, durationMs: number): CaseLatencyResult {
  // Per-case SLO: use p95 as the primary gate.
  // If per-case p95 not defined, the case passes (aggregate SLO from thresholds applies).
  const slo = benchmarkCase.slo_p95_ms;
  const pass = slo === undefined || durationMs <= slo;
  const violationReason =
    !pass && slo !== undefined
      ? `${durationMs.toFixed(0)}ms > p95 SLO ${slo}ms`
      : null;

  return {
    benchmark_id: benchmarkCase.benchmark_id,
    query: benchmarkCase.query,
    duration_ms: durationMs,
    slo_p95_ms: slo,
    pass,
    violation_reason: violationReason,
  };
}

// ─── Percentile ──────────────────────────────────────────────────────────────

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo] ?? 0;
  const loVal = sortedAsc[lo] ?? 0;
  const hiVal = sortedAsc[hi] ?? 0;
  return loVal + (hiVal - loVal) * (idx - lo);
}

// ─── Report builder ───────────────────────────────────────────────────────────

export function buildPerformanceLatencyReport(
  results: readonly CaseLatencyResult[],
): PerformanceLatencyFixtureReport {
  const count = results.length;
  const durations = results.map((r) => r.duration_ms).sort((a, b) => a - b);
  const sloPassCount = results.filter((r) => r.pass).length;

  const failures = results
    .filter((r) => !r.pass)
    .slice(0, MAX_FAILURES_IN_REPORT)
    .map((r) => ({
      benchmark_id: r.benchmark_id,
      query: r.query,
      duration_ms: r.duration_ms,
      slo_p95_ms: r.slo_p95_ms,
      violation_reason: r.violation_reason,
    }));

  return {
    benchmark: 'performance-latency-fixture',
    suite_id: SUITE_ID,
    query_count: count,
    slo_pass_rate: count === 0 ? 0 : sloPassCount / count,
    latency_summary: {
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      p99: percentile(durations, 0.99),
    },
    min_pass_rate: count === 0 ? 0 : sloPassCount / count,
    failures,
    evaluated_at: new Date().toISOString(),
  };
}

// ─── Threshold assertion ──────────────────────────────────────────────────────

async function assertThresholds(report: PerformanceLatencyFixtureReport): Promise<void> {
  const thresholds = await loadFixtureThresholds();
  const suiteThresholds = thresholds[SUITE_ID];
  if (typeof suiteThresholds !== 'object' || suiteThresholds === null) return;
  const record = suiteThresholds as Readonly<Record<string, unknown>>;
  const violations: string[] = [];

  const sloPassRate = readNumericThreshold(record, 'slo_pass_rate');
  if (sloPassRate !== undefined && report.slo_pass_rate < sloPassRate) {
    violations.push(
      `slo_pass_rate=${report.slo_pass_rate.toFixed(4)} < threshold ${sloPassRate.toFixed(4)}`,
    );
  }

  const minPassRate = readNumericThreshold(record, 'min_pass_rate');
  if (minPassRate !== undefined && report.min_pass_rate < minPassRate) {
    violations.push(
      `min_pass_rate=${report.min_pass_rate.toFixed(4)} < threshold ${minPassRate.toFixed(4)}`,
    );
  }

  // Aggregate p95 gate (applies when external thresholds define a global limit).
  const p95Threshold = readNumericThreshold(record, 'latency_p95_ms');
  if (p95Threshold !== undefined && report.latency_summary.p95 > p95Threshold) {
    violations.push(
      `latency_summary.p95=${report.latency_summary.p95.toFixed(0)}ms > threshold ${p95Threshold.toFixed(0)}ms`,
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `performance_latency fixture gate failed:\n- ${violations.join('\n- ')}`,
    );
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await runLiveBenchmarkPreflight({
    apiUrl: args.apiUrl,
    executionLane: args.executionLane,
    debugKey: args.debugKey,
  });

  const rawCases = await loadFixtureCases([SUITE_ID]);
  const cases = rawCases.map(adaptCase);

  process.stderr.write(`[perf-latency-fixture-eval] ${cases.length} cases, concurrency=${args.concurrency}\n`);

  if (args.warmup > 0) {
    process.stderr.write(`[perf-latency-fixture-eval] warming up (${args.warmup} requests)...\n`);
    await warmUp(args.apiUrl, args.warmup, args.timeoutMs, args.executionLane, args.debugKey);
  }

  const caseResults = await mapPool(cases, args.concurrency, async (benchmarkCase) => {
    const durationMs = await measureLatency(
      args.apiUrl,
      benchmarkCase.query,
      args.timeoutMs,
      args.executionLane,
      args.debugKey,
    );
    return evaluateCase(benchmarkCase, durationMs);
  });

  const report = buildPerformanceLatencyReport(caseResults);

  await fs.writeFile(args.output, JSON.stringify(report, null, 2), 'utf8');
  process.stderr.write(`[perf-latency-fixture-eval] wrote ${args.output}\n`);
  process.stderr.write(
    `[perf-latency-fixture-eval] p50=${report.latency_summary.p50.toFixed(0)}ms p95=${report.latency_summary.p95.toFixed(0)}ms p99=${report.latency_summary.p99.toFixed(0)}ms pass=${report.slo_pass_rate.toFixed(4)}\n`,
  );

  if (args.useThresholds) {
    await assertThresholds(report);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[perf-latency-fixture-eval] fatal: ${message}\n`);
    process.exit(1);
  });
}
