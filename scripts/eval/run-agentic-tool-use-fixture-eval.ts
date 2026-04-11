#!/usr/bin/env tsx

import 'dotenv/config';
import fs from 'node:fs/promises';

import { loadFixtureCases, loadFixtureThresholds, readNumericThreshold } from './external-fixture-benchmark.js';
import {
  callAgentApi,
  collectToolCalls,
  evaluateAnswerPatterns,
  evaluateExpectedToolSequence,
  type AgentFixtureCase,
} from './agent-fixture-runner-common.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';

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
}

interface ToolUseFixtureReport {
  readonly benchmark: 'agentic-tool-use-fixture';
  readonly suite_id: 'agentic_tool_use';
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
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';
  let timeoutMs = 90_000;
  let useThresholds = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' || arg === '-o') {
      output = argv[++i] ?? output;
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

function castAgentFixtureCase(raw: unknown): AgentFixtureCase {
  return raw as AgentFixtureCase;
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
  const rawCases = await loadFixtureCases([SUITE_ID]);
  const cases = rawCases.map(castAgentFixtureCase);
  const results: ToolUseCaseResult[] = [];

  for (const benchmarkCase of cases) {
    const response = await callAgentApi(args.apiUrl, benchmarkCase.query, benchmarkCase.max_steps, args.timeoutMs);
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

  if (args.useThresholds) {
    await assertThresholds(report);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
