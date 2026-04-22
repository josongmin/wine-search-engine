#!/usr/bin/env tsx

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();
import fs from 'node:fs/promises';

import { loadFixtureCases, loadFixtureThresholds, readNumericThreshold } from './external-fixture-benchmark.js';
import {
  assertAgentHttpEntrypointReady,
  callAgentApi,
  classifyAgentApiFailure,
  collectToolCalls,
  evaluateAnswerPatterns,
  evaluateExpectedToolSequence,
  normalizeAgentFixtureCase,
} from './agent-fixture-runner-common.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import { resolveCliDataPathArg } from './cli-data-path.js';
import { getCurrentFeatureSchemaHash } from '../../src/domain/ranking/service/feature-parity-hash.js';
import { bootstrapBenchmarkLedgerPersistence } from './benchmark-ledger-bootstrap.js';

const DEFAULT_OUTPUT = resolveDataPath('data/agentic-tool-use-fixture-eval-results.json');
const SUITE_ID = 'agentic_tool_use';

interface CliArgs {
  readonly output: string;
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly useThresholds: boolean;
}

interface ToolUseCaseResult {
  readonly id: string;
  readonly pass: boolean;
  readonly toolSelectionPass: boolean;
  readonly stepBudgetPass: boolean;
  readonly patternCoveragePass: boolean;
  readonly forbiddenPatternViolation: boolean;
  readonly durationMs: number;
  readonly toolCalls: readonly string[];
  readonly failure_kind?: string;
  readonly failure_message?: string;
}

interface ToolUseFixtureReport {
  readonly benchmark: 'agentic-tool-use-fixture';
  readonly suite_id: 'agentic_tool_use';
  readonly transport: 'http';
  readonly endpoint: '/v1/agent';
  readonly operation_id: 'agent.execute';
  readonly query_count: number;
  readonly tool_selection_accuracy: number;
  readonly step_budget_compliance: number;
  readonly pattern_coverage_rate: number;
  readonly forbidden_pattern_violation_rate: number;
  readonly latency_p95_ms: number;
  readonly min_pass_rate: number;
  readonly failures: readonly ToolUseCaseResult[];
  readonly evaluated_at: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let output = DEFAULT_OUTPUT;
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://127.0.0.1:3000';
  let timeoutMs = 90_000;
  let useThresholds = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' || arg === '-o') {
      output = resolveCliDataPathArg(argv[++i] ?? output);
    } else if (arg === '--api-url') {
      apiUrl = argv[++i] ?? apiUrl;
    } else if (arg === '--timeout-ms') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed >= 1000) timeoutMs = parsed;
    } else if (arg === '--no-thresholds') {
      useThresholds = false;
    }
  }

  return { output, apiUrl, timeoutMs, useThresholds };
}

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

export function buildToolUseFixtureReport(
  results: readonly ToolUseCaseResult[],
): ToolUseFixtureReport {
  const sortedDurations = results.map((item) => item.durationMs).sort((a, b) => a - b);
  const count = results.length;
  const failures = results.filter((item) => !item.pass).slice(0, 25);
  return {
    benchmark: 'agentic-tool-use-fixture',
    suite_id: SUITE_ID,
    transport: 'http',
    endpoint: '/v1/agent',
    operation_id: 'agent.execute',
    query_count: count,
    tool_selection_accuracy: count === 0 ? 0 : results.filter((item) => item.toolSelectionPass).length / count,
    step_budget_compliance: count === 0 ? 0 : results.filter((item) => item.stepBudgetPass).length / count,
    pattern_coverage_rate: count === 0 ? 0 : results.filter((item) => item.patternCoveragePass).length / count,
    forbidden_pattern_violation_rate: count === 0 ? 0 : results.filter((item) => item.forbiddenPatternViolation).length / count,
    latency_p95_ms: percentile(sortedDurations, 0.95),
    min_pass_rate: count === 0 ? 0 : results.filter((item) => item.pass).length / count,
    failures,
    evaluated_at: new Date().toISOString(),
  };
}

async function assertThresholds(report: ToolUseFixtureReport): Promise<void> {
  const thresholds = await loadFixtureThresholds();
  const suiteThresholds = thresholds[SUITE_ID];
  if (typeof suiteThresholds !== 'object' || suiteThresholds === null) return;
  const record = suiteThresholds as Readonly<Record<string, unknown>>;
  const violations: string[] = [];

  const toolSelectionAccuracy = readNumericThreshold(record, 'tool_selection_accuracy');
  if (toolSelectionAccuracy !== undefined && report.tool_selection_accuracy < toolSelectionAccuracy) {
    violations.push(`tool_selection_accuracy=${report.tool_selection_accuracy.toFixed(4)} < ${toolSelectionAccuracy.toFixed(4)}`);
  }

  const stepBudgetCompliance = readNumericThreshold(record, 'step_budget_compliance');
  if (stepBudgetCompliance !== undefined && report.step_budget_compliance < stepBudgetCompliance) {
    violations.push(`step_budget_compliance=${report.step_budget_compliance.toFixed(4)} < ${stepBudgetCompliance.toFixed(4)}`);
  }

  const minPassRate = readNumericThreshold(record, 'min_pass_rate');
  if (minPassRate !== undefined && report.min_pass_rate < minPassRate) {
    violations.push(`min_pass_rate=${report.min_pass_rate.toFixed(4)} < ${minPassRate.toFixed(4)}`);
  }

  if (violations.length > 0) {
    throw new Error(`Agentic tool-use fixture gate failed:\n- ${violations.join('\n- ')}`);
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await assertAgentHttpEntrypointReady(args.apiUrl, Math.min(args.timeoutMs, 10_000));
  const rawCases = await loadFixtureCases([SUITE_ID]);
  const cases = rawCases.map(normalizeAgentFixtureCase);
  const results: ToolUseCaseResult[] = [];

  for (const benchmarkCase of cases) {
    const response = await callAgentApi(args.apiUrl, benchmarkCase.query, benchmarkCase.max_steps, args.timeoutMs).catch((err: unknown) => {
      const failure = classifyAgentApiFailure(err);
      results.push({
        id: benchmarkCase.id,
        pass: false,
        toolSelectionPass: false,
        stepBudgetPass: false,
        patternCoveragePass: false,
        forbiddenPatternViolation: false,
        durationMs: 0,
        toolCalls: [],
        failure_kind: failure.kind,
        failure_message: failure.message,
      });
      return undefined;
    });
    if (response === undefined) {
      continue;
    }
    const toolCalls = collectToolCalls(response.steps);
    const toolSelectionPass = evaluateExpectedToolSequence(toolCalls, benchmarkCase.expected_tools ?? []);
    const stepBudgetPass = benchmarkCase.max_steps === undefined
      ? true
      : response.steps.length <= benchmarkCase.max_steps;
    const answerPatterns = evaluateAnswerPatterns(
      response.answer,
      benchmarkCase.answer_must_match,
      benchmarkCase.answer_must_not_match,
    );

    results.push({
      id: benchmarkCase.id,
      pass: toolSelectionPass
        && stepBudgetPass
        && answerPatterns.patternCoveragePass
        && !answerPatterns.forbiddenPatternViolation,
      toolSelectionPass,
      stepBudgetPass,
      patternCoveragePass: answerPatterns.patternCoveragePass,
      forbiddenPatternViolation: answerPatterns.forbiddenPatternViolation,
      durationMs: response.meta.total_duration_ms,
      toolCalls: toolCalls.map((item) => item.tool),
    });
  }

  const report = buildToolUseFixtureReport(results);
  await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('Agentic tool-use fixture benchmark complete');
  console.log(`  cases: ${report.query_count}`);
  console.log(`  tool_selection_accuracy: ${report.tool_selection_accuracy.toFixed(4)}`);
  console.log(`  step_budget_compliance: ${report.step_budget_compliance.toFixed(4)}`);
  console.log(`  min_pass_rate: ${report.min_pass_rate.toFixed(4)}`);
  console.log(`  latency_p95_ms: ${report.latency_p95_ms.toFixed(0)}`);
  console.log(`  output: ${args.output}`);

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
    const ledger = await bootstrapBenchmarkLedgerPersistence();
    try {
      if (ledger.status === 'skipped') {
        console.warn(`  [WARN] Skipped benchmark DB persistence: ${ledger.detail}`);
      } else {
        const persistResult = await ledger.persistRun({
          benchmarkKind: 'agentic_tool_use_fixture',
          evalDatasetVersion: 'v1',
          featureSchemaHash: getCurrentFeatureSchemaHash(),
          queryCount: report.query_count,
          releaseGatePassed: thresholdsPassed,
          activationStatus: 'shadow_only',
          report: report as unknown as Readonly<Record<string, unknown>>,
          metrics: {
            tool_selection_accuracy: report.tool_selection_accuracy,
            step_budget_compliance: report.step_budget_compliance,
            pass_rate: report.min_pass_rate,
          },
        });
        if (persistResult.status === 'persisted') {
          console.log(`  Benchmark run persisted to DB (${persistResult.runId}).`);
        } else {
          console.warn(`  [WARN] Skipped benchmark DB persistence: ${persistResult.detail}`);
        }
      }
    } finally {
      await ledger.close();
    }
  } catch (persistErr: unknown) {
    const msg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    console.warn(`  [WARN] Could not persist benchmark run to DB: ${msg}`);
  }

  if (thresholdError !== undefined) {
    throw thresholdError;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
