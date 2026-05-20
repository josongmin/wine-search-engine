#!/usr/bin/env tsx
/**
 * Fixture-native performance_load benchmark runner.
 * ADR-005 Workstream C.
 *
 * Evaluates sustained-load characteristics:
 * - achieved RPS
 * - error rate
 * - p99 latency under load
 *
 * Workload shape (concurrency, duration, request mix) comes from external
 * fixture suite cases. SLO thresholds come from external thresholds.json.
 * No internal constant decides the release gate outcome.
 *
 * Usage:
 *   npx tsx scripts/eval/run-performance-load-fixture-eval.ts
 *   npx tsx scripts/eval/run-performance-load-fixture-eval.ts \
 *     --output data/perf-load-results.json --api-url http://localhost:3000
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
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import {
  buildBenchmarkRequestHeaders,
  resolveBenchmarkSearchEndpoint,
  runLiveBenchmarkPreflight,
  type BenchmarkExecutionLane,
} from './live-benchmark-preflight.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

const SUITE_ID = 'performance_load' as const;
const DEFAULT_OUTPUT = resolveDataPath('data/performance-load-fixture-eval-results.json');

/** Maximum failure records included in the report. */
const MAX_FAILURES_IN_REPORT = 50;

interface CliArgs {
  readonly output: string;
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly executionLane: BenchmarkExecutionLane;
  readonly debugKey?: string;
  readonly useThresholds: boolean;
}

/** Typed view of a performance_load fixture case. */
interface LoadCase {
  readonly benchmark_id: string;
  readonly query: string;
  readonly category: string;
  /** Target concurrency level for this case's load shape. */
  readonly concurrency: number;
  /** Duration to sustain the load (ms). */
  readonly duration_ms: number;
  /** Target RPS — if 0 or undefined, runner measures achieved RPS. */
  readonly target_rps: number | undefined;
  /** Per-case error rate ceiling [0,1]. */
  readonly max_error_rate: number | undefined;
  /** Per-case p99 latency ceiling (ms). */
  readonly slo_p99_ms: number | undefined;
}

interface CaseLoadResult {
  readonly benchmark_id: string;
  readonly query: string;
  readonly achieved_rps: number;
  readonly error_rate: number;
  readonly p99_latency_ms: number;
  readonly pass: boolean;
  readonly violation_reason: string | null;
}

/** Required output report shape (ADR-005 Workstream C). */
export interface PerformanceLoadFixtureReport {
  readonly benchmark: 'performance-load-fixture';
  readonly suite_id: 'performance_load';
  readonly execution_lane: BenchmarkExecutionLane;
  readonly query_count: number;
  readonly achieved_rps: number;
  readonly error_rate: number;
  readonly p99_latency_under_load_ms: number;
  readonly min_pass_rate: number;
  readonly failures: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly achieved_rps: number;
    readonly error_rate: number;
    readonly p99_latency_ms: number;
    readonly violation_reason: string | null;
  }[];
  readonly evaluated_at: string;
}

// ─── Arg parser ──────────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): CliArgs {
  let output = DEFAULT_OUTPUT;
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';
  let timeoutMs = 30_000;
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

  return { output, apiUrl, timeoutMs, executionLane, debugKey, useThresholds };
}

// ─── Fixture case adapter ────────────────────────────────────────────────────

function adaptCase(raw: unknown): LoadCase {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid fixture case: not an object');
  }
  const c = raw as Record<string, unknown>;
  const evaluation = c['evaluation'] as Record<string, unknown> | undefined;
  if (typeof evaluation !== 'object' || evaluation === null) {
    throw new Error(`Fixture case ${String(c['id'])} is missing evaluation`);
  }

  // Load shape: concurrency and duration from evaluation fields.
  const concurrency = typeof evaluation['concurrency'] === 'number' ? evaluation['concurrency'] : 4;
  const durationMs = typeof evaluation['max_duration_ms'] === 'number' ? evaluation['max_duration_ms'] : 10_000;

  // Throughput SLO from evaluation.throughput_slo_rps.
  const targetRps =
    typeof evaluation['throughput_slo_rps'] === 'number'
      ? evaluation['throughput_slo_rps']
      : undefined;

  // Latency SLO from evaluation.latency_slo_ms.p99 (reuses same schema as latency suite).
  const sloObj = evaluation['latency_slo_ms'];
  const sloP99 =
    typeof sloObj === 'object' && sloObj !== null && typeof (sloObj as Record<string, unknown>)['p99'] === 'number'
      ? (sloObj as Record<string, unknown>)['p99'] as number
      : undefined;

  return {
    benchmark_id: String(c['id'] ?? ''),
    query: String(c['query'] ?? ''),
    category: String(c['category'] ?? ''),
    concurrency,
    duration_ms: durationMs,
    target_rps: targetRps,
    max_error_rate: undefined, // comes from aggregate thresholds, not per-case
    slo_p99_ms: sloP99,
  };
}

// ─── Load executor ────────────────────────────────────────────────────────────

interface RequestOutcome {
  readonly durationMs: number;
  readonly success: boolean;
}

/**
 * Executes a sustained load against a single query for the specified duration.
 * Maintains `concurrency` in-flight requests at all times.
 * Returns individual request outcomes for percentile computation.
 */
async function executeSustainedLoad(
  apiUrl: string,
  query: string,
  concurrency: number,
  durationMs: number,
  timeoutMs: number,
  executionLane: BenchmarkExecutionLane,
  debugKey?: string,
): Promise<readonly RequestOutcome[]> {
  const outcomes: RequestOutcome[] = [];
  const startTime = performance.now();
  let activeWorkers = 0;
  let done = false;
  const endpoint = resolveBenchmarkSearchEndpoint(apiUrl, executionLane);
  const headers = buildBenchmarkRequestHeaders(executionLane, debugKey);

  await new Promise<void>((resolve) => {
    function trySpawn(): void {
      while (activeWorkers < concurrency && !done) {
        if (performance.now() - startTime >= durationMs) {
          done = true;
          if (activeWorkers === 0) resolve();
          return;
        }
        activeWorkers++;
        const reqStart = performance.now();
        fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ query }),
          signal: AbortSignal.timeout(timeoutMs),
        })
          .then(async (res) => { await res.text(); return res.ok; })
          .then((success) => {
            outcomes.push({ durationMs: performance.now() - reqStart, success });
          })
          .catch(() => {
            outcomes.push({ durationMs: performance.now() - reqStart, success: false });
          })
          .finally(() => {
            activeWorkers--;
            if (done && activeWorkers === 0) {
              resolve();
            } else {
              trySpawn();
            }
          });
      }
    }
    trySpawn();
  });

  return outcomes;
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

// ─── Case evaluator ──────────────────────────────────────────────────────────

function evaluateCase(benchmarkCase: LoadCase, outcomes: readonly RequestOutcome[]): CaseLoadResult {
  const totalRequests = outcomes.length;
  const errorCount = outcomes.filter((o) => !o.success).length;
  const errorRate = totalRequests === 0 ? 1 : errorCount / totalRequests;

  const durations = outcomes.map((o) => o.durationMs).sort((a, b) => a - b);
  const p99Ms = percentile(durations, 0.99);

  // achieved RPS = total successful requests / actual measurement window (seconds).
  // Use duration_ms from case as the denominator — executor ran for that long.
  const durationSec = benchmarkCase.duration_ms / 1000;
  const achievedRps = durationSec > 0 ? (totalRequests - errorCount) / durationSec : 0;

  const violations: string[] = [];

  if (benchmarkCase.target_rps !== undefined && achievedRps < benchmarkCase.target_rps) {
    violations.push(
      `achieved_rps=${achievedRps.toFixed(2)} < target ${benchmarkCase.target_rps.toFixed(2)}`,
    );
  }

  if (benchmarkCase.slo_p99_ms !== undefined && p99Ms > benchmarkCase.slo_p99_ms) {
    violations.push(
      `p99=${p99Ms.toFixed(0)}ms > SLO ${benchmarkCase.slo_p99_ms}ms`,
    );
  }

  const pass = violations.length === 0;

  return {
    benchmark_id: benchmarkCase.benchmark_id,
    query: benchmarkCase.query,
    achieved_rps: achievedRps,
    error_rate: errorRate,
    p99_latency_ms: p99Ms,
    pass,
    violation_reason: violations.length > 0 ? violations.join('; ') : null,
  };
}

// ─── Report builder ───────────────────────────────────────────────────────────

export function buildPerformanceLoadReport(
  results: readonly CaseLoadResult[],
  executionLane: BenchmarkExecutionLane = 'trusted_benchmark',
): PerformanceLoadFixtureReport {
  const count = results.length;
  const passCount = results.filter((r) => r.pass).length;

  // Aggregate across all cases.
  let totalRps = 0;
  let totalErrorRateSum = 0;
  const allP99s: number[] = [];

  for (const r of results) {
    totalRps += r.achieved_rps;
    totalErrorRateSum += r.error_rate;
    allP99s.push(r.p99_latency_ms);
  }

  const aggregateRps = count === 0 ? 0 : totalRps / count;
  const aggregateErrorRate = count === 0 ? 0 : totalErrorRateSum / count;
  const sortedP99s = allP99s.sort((a, b) => a - b);
  const aggregateP99 = percentile(sortedP99s, 0.99);

  const failures = results
    .filter((r) => !r.pass)
    .slice(0, MAX_FAILURES_IN_REPORT)
    .map((r) => ({
      benchmark_id: r.benchmark_id,
      query: r.query,
      achieved_rps: r.achieved_rps,
      error_rate: r.error_rate,
      p99_latency_ms: r.p99_latency_ms,
      violation_reason: r.violation_reason,
    }));

  return {
    benchmark: 'performance-load-fixture',
    suite_id: SUITE_ID,
    execution_lane: executionLane,
    query_count: count,
    achieved_rps: aggregateRps,
    error_rate: aggregateErrorRate,
    p99_latency_under_load_ms: aggregateP99,
    min_pass_rate: count === 0 ? 0 : passCount / count,
    failures,
    evaluated_at: new Date().toISOString(),
  };
}

// ─── Threshold assertion ──────────────────────────────────────────────────────

async function assertThresholds(report: PerformanceLoadFixtureReport): Promise<void> {
  const thresholds = await loadFixtureThresholds();
  const suiteThresholds = thresholds[SUITE_ID];
  if (typeof suiteThresholds !== 'object' || suiteThresholds === null) return;
  const record = suiteThresholds as Readonly<Record<string, unknown>>;
  const violations: string[] = [];

  const achievedRps = readNumericThreshold(record, 'achieved_rps');
  if (achievedRps !== undefined && report.achieved_rps < achievedRps) {
    violations.push(
      `achieved_rps=${report.achieved_rps.toFixed(2)} < threshold ${achievedRps.toFixed(2)}`,
    );
  }

  const maxErrorRate = readNumericThreshold(record, 'error_rate');
  if (maxErrorRate !== undefined && report.error_rate > maxErrorRate) {
    violations.push(
      `error_rate=${report.error_rate.toFixed(4)} > threshold ${maxErrorRate.toFixed(4)}`,
    );
  }

  const p99Threshold = readNumericThreshold(record, 'p99_latency_under_load_ms');
  if (p99Threshold !== undefined && report.p99_latency_under_load_ms > p99Threshold) {
    violations.push(
      `p99_latency_under_load_ms=${report.p99_latency_under_load_ms.toFixed(0)}ms > threshold ${p99Threshold.toFixed(0)}ms`,
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
      `performance_load fixture gate failed:\n- ${violations.join('\n- ')}`,
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

  process.stderr.write(`[perf-load-fixture-eval] ${cases.length} cases\n`);

  const caseResults: CaseLoadResult[] = [];
  for (const benchmarkCase of cases) {
    process.stderr.write(
      `[perf-load-fixture-eval] running ${benchmarkCase.benchmark_id} (concurrency=${benchmarkCase.concurrency}, duration=${benchmarkCase.duration_ms}ms)\n`,
    );
    const outcomes = await executeSustainedLoad(
      args.apiUrl,
      benchmarkCase.query,
      benchmarkCase.concurrency,
      benchmarkCase.duration_ms,
      args.timeoutMs,
      args.executionLane,
      args.debugKey,
    );
    caseResults.push(evaluateCase(benchmarkCase, outcomes));
  }

  const report = buildPerformanceLoadReport(caseResults, args.executionLane);

  await fs.writeFile(args.output, JSON.stringify(report, null, 2), 'utf8');
  process.stderr.write(`[perf-load-fixture-eval] wrote ${args.output}\n`);
  process.stderr.write(
    `[perf-load-fixture-eval] rps=${report.achieved_rps.toFixed(2)} error_rate=${report.error_rate.toFixed(4)} p99=${report.p99_latency_under_load_ms.toFixed(0)}ms pass=${report.min_pass_rate.toFixed(4)}\n`,
  );

  if (args.useThresholds) {
    await assertThresholds(report);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[perf-load-fixture-eval] fatal: ${message}\n`);
    process.exit(1);
  });
}
