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
  createJudgeLlm,
  evaluateAnswerPatterns,
  judgeFixtureAnswer,
  normalizeAgentFixtureCase,
} from './agent-fixture-runner-common.js';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { resolveCliDataPathArg } from './cli-data-path.js';
import { getCurrentFeatureSchemaHash } from '../../src/domain/ranking/service/feature-parity-hash.js';
import { bootstrapBenchmarkLedgerPersistence } from './benchmark-ledger-bootstrap.js';
import { AGENT_FIXTURE_ANSWER_QUALITY_DEFAULT_JUDGE_MODEL } from './agent-fixture-judge-config.js';

const DEFAULT_OUTPUT = resolveDataPath('data/agentic-answer-quality-fixture-eval-results.json');
const SUITE_ID = 'agentic_answer_quality';
const JUDGE_PASS_SCORE = 0.75;

interface CliArgs {
  readonly output: string;
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly judgeModel: string;
  readonly judgeSamples: number;
  readonly useThresholds: boolean;
}

interface AnswerQualityCaseResult {
  readonly id: string;
  readonly pass: boolean;
  readonly rubricPass: boolean;
  readonly patternCoveragePass: boolean;
  readonly forbiddenPatternViolation: boolean;
  readonly judgeScore: number | null;
  readonly durationMs: number;
  readonly failure_kind?: string;
  readonly failure_message?: string;
}

interface AnswerQualityFixtureReport {
  readonly benchmark: 'agentic-answer-quality-fixture';
  readonly suite_id: 'agentic_answer_quality';
  readonly transport: 'http';
  readonly endpoint: '/v1/agent';
  readonly operation_id: 'agent.execute';
  readonly query_count: number;
  readonly rubric_pass_rate: number;
  readonly pattern_coverage_rate: number;
  readonly forbidden_pattern_violation_rate: number;
  readonly min_pass_rate: number;
  readonly judge_model: string;
  readonly judge_samples: number;
  readonly failures: readonly AnswerQualityCaseResult[];
  readonly evaluated_at: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let output = DEFAULT_OUTPUT;
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://127.0.0.1:3000';
  let timeoutMs = 90_000;
  let judgeModel = AGENT_FIXTURE_ANSWER_QUALITY_DEFAULT_JUDGE_MODEL;
  let judgeSamples = 3;
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
    } else if (arg === '--judge-model') {
      judgeModel = argv[++i] ?? judgeModel;
    } else if (arg === '--judge-samples') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed >= 1) judgeSamples = parsed;
    } else if (arg === '--no-thresholds') {
      useThresholds = false;
    }
  }

  return { output, apiUrl, timeoutMs, judgeModel, judgeSamples, useThresholds };
}

export function buildAnswerQualityFixtureReport(
  results: readonly AnswerQualityCaseResult[],
  judgeModel: string,
  judgeSamples: number,
): AnswerQualityFixtureReport {
  const count = results.length;
  return {
    benchmark: 'agentic-answer-quality-fixture',
    suite_id: SUITE_ID,
    transport: 'http',
    endpoint: '/v1/agent',
    operation_id: 'agent.execute',
    query_count: count,
    rubric_pass_rate: count === 0 ? 0 : results.filter((item) => item.rubricPass).length / count,
    pattern_coverage_rate: count === 0 ? 0 : results.filter((item) => item.patternCoveragePass).length / count,
    forbidden_pattern_violation_rate: count === 0 ? 0 : results.filter((item) => item.forbiddenPatternViolation).length / count,
    min_pass_rate: count === 0 ? 0 : results.filter((item) => item.pass).length / count,
    judge_model: judgeModel,
    judge_samples: judgeSamples,
    failures: results.filter((item) => !item.pass).slice(0, 25),
    evaluated_at: new Date().toISOString(),
  };
}

async function assertThresholds(report: AnswerQualityFixtureReport): Promise<void> {
  const thresholds = await loadFixtureThresholds();
  const suiteThresholds = thresholds[SUITE_ID];
  if (typeof suiteThresholds !== 'object' || suiteThresholds === null) return;
  const record = suiteThresholds as Readonly<Record<string, unknown>>;
  const violations: string[] = [];

  const rubricPassRate = readNumericThreshold(record, 'rubric_pass_rate');
  if (rubricPassRate !== undefined && report.rubric_pass_rate < rubricPassRate) {
    violations.push(`rubric_pass_rate=${report.rubric_pass_rate.toFixed(4)} < ${rubricPassRate.toFixed(4)}`);
  }

  const patternCoverageRate = readNumericThreshold(record, 'pattern_coverage_rate');
  if (patternCoverageRate !== undefined && report.pattern_coverage_rate < patternCoverageRate) {
    violations.push(`pattern_coverage_rate=${report.pattern_coverage_rate.toFixed(4)} < ${patternCoverageRate.toFixed(4)}`);
  }

  const forbiddenPatternViolationRate = readNumericThreshold(record, 'forbidden_pattern_violation_rate');
  if (
    forbiddenPatternViolationRate !== undefined
    && report.forbidden_pattern_violation_rate > forbiddenPatternViolationRate
  ) {
    violations.push(
      `forbidden_pattern_violation_rate=${report.forbidden_pattern_violation_rate.toFixed(4)} > ${forbiddenPatternViolationRate.toFixed(4)}`,
    );
  }

  const minPassRate = readNumericThreshold(record, 'min_pass_rate');
  if (minPassRate !== undefined && report.min_pass_rate < minPassRate) {
    violations.push(`min_pass_rate=${report.min_pass_rate.toFixed(4)} < ${minPassRate.toFixed(4)}`);
  }

  if (violations.length > 0) {
    throw new Error(`Agentic answer-quality fixture gate failed:\n- ${violations.join('\n- ')}`);
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await assertAgentHttpEntrypointReady(args.apiUrl, Math.min(args.timeoutMs, 10_000));
  const rawCases = await loadFixtureCases([SUITE_ID]);
  const cases = rawCases.map(normalizeAgentFixtureCase);
  const judgeLlm = createJudgeLlm(args.judgeModel);
  const results: AnswerQualityCaseResult[] = [];

  for (const benchmarkCase of cases) {
    const response = await callAgentApi(args.apiUrl, benchmarkCase.query, benchmarkCase.max_steps, args.timeoutMs).catch((err: unknown) => {
      const failure = classifyAgentApiFailure(err);
      results.push({
        id: benchmarkCase.id,
        pass: false,
        rubricPass: false,
        patternCoveragePass: false,
        forbiddenPatternViolation: false,
        judgeScore: null,
        durationMs: 0,
        failure_kind: failure.kind,
        failure_message: failure.message,
      });
      return undefined;
    });
    if (response === undefined) {
      continue;
    }
    const answerPatterns = evaluateAnswerPatterns(
      response.answer,
      benchmarkCase.answer_must_match,
      benchmarkCase.answer_must_not_match,
    );
    const judge = await judgeFixtureAnswer(
      judgeLlm,
      benchmarkCase,
      response.answer,
      args.judgeSamples,
    );
    const rubricPass = (judge.score ?? 0) >= JUDGE_PASS_SCORE;

    results.push({
      id: benchmarkCase.id,
      pass: rubricPass && answerPatterns.patternCoveragePass && !answerPatterns.forbiddenPatternViolation,
      rubricPass,
      patternCoveragePass: answerPatterns.patternCoveragePass,
      forbiddenPatternViolation: answerPatterns.forbiddenPatternViolation,
      judgeScore: judge.score,
      durationMs: response.meta.total_duration_ms,
    });
  }

  const report = buildAnswerQualityFixtureReport(results, args.judgeModel, args.judgeSamples);
  await fs.writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('Agentic answer-quality fixture benchmark complete');
  console.log(`  cases: ${report.query_count}`);
  console.log(`  rubric_pass_rate: ${report.rubric_pass_rate.toFixed(4)}`);
  console.log(`  pattern_coverage_rate: ${report.pattern_coverage_rate.toFixed(4)}`);
  console.log(`  forbidden_pattern_violation_rate: ${report.forbidden_pattern_violation_rate.toFixed(4)}`);
  console.log(`  min_pass_rate: ${report.min_pass_rate.toFixed(4)}`);
  console.log(`  judge_model: ${report.judge_model} (N=${report.judge_samples})`);
  console.log(`  output: ${args.output}`);

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

  try {
    const ledger = await bootstrapBenchmarkLedgerPersistence();
    try {
      if (ledger.status === 'skipped') {
        console.warn(`  [WARN] Skipped benchmark DB persistence: ${ledger.detail}`);
      } else {
        const persistResult = await ledger.persistRun({
          benchmarkKind: 'agentic_answer_quality_fixture',
          evalDatasetVersion: 'v1',
          featureSchemaHash: getCurrentFeatureSchemaHash(),
          queryCount: report.query_count,
          releaseGatePassed: thresholdsPassed,
          activationStatus: 'shadow_only',
          report: report as unknown as Readonly<Record<string, unknown>>,
          metrics: {
            rubric_pass_rate: report.rubric_pass_rate,
            pattern_coverage_rate: report.pattern_coverage_rate,
            forbidden_pattern_violation_rate: report.forbidden_pattern_violation_rate,
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
