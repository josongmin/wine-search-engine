#!/usr/bin/env tsx
/**
 * External fixture-driven entity retrieval benchmark runner.
 *
 * Suites:
 * - exact_entity_recovery
 * - ambiguous_shortform
 * - mixed_script_entity
 *
 * Reads benchmark truth from wine-engine-fixture (ADR-004 SSOT), not from
 * in-repo JSONL artifacts.
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();
import fs from 'node:fs/promises';
import {
  loadEntityRetrievalFixtureCases,
  loadFixtureThresholds,
  parseSuiteIdList,
  readNumericThreshold,
  type EntityRetrievalSuiteId,
  type FixtureEntityBenchmarkCase,
} from './external-fixture-benchmark.js';
import {
  fetchLiveRankings,
  loadNoisyEntityPredictions,
  type NoisyEntityDecisionStatus,
  type RankedEntity,
} from './run-noisy-entity-eval.js';
import { resolveDataPath } from '../../src/shared/utils/data-paths.js';
import {
  runLiveBenchmarkPreflight,
  type BenchmarkExecutionLane,
} from './live-benchmark-preflight.js';

const DEFAULT_OUTPUT = resolveDataPath('data/entity-retrieval-fixture-eval-results.json');
const DEFAULT_SUITES = [
  'exact_entity_recovery',
  'ambiguous_shortform',
  'mixed_script_entity',
] as const satisfies readonly EntityRetrievalSuiteId[];

interface CliArgs {
  readonly output: string;
  readonly apiUrl: string;
  readonly predictions: string | null;
  readonly smokePredictions: boolean;
  readonly mode: 'auto' | 'hybrid' | 'entity';
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly executionLane: BenchmarkExecutionLane;
  readonly debugKey?: string;
  readonly suites: readonly EntityRetrievalSuiteId[];
  readonly useThresholds: boolean;
}

interface RankedPrediction {
  readonly rankedEntities: readonly RankedEntity[];
  readonly decisionStatus?: NoisyEntityDecisionStatus;
}

interface SuiteMetrics {
  readonly suite_id: EntityRetrievalSuiteId;
  readonly query_count: number;
  readonly top1_accuracy: number | null;
  readonly topk_accuracy: number | null;
  readonly safe_response_rate: number | null;
  readonly wrong_top1_rate: number | null;
  readonly wrong_confident_top1_rate: number | null;
  readonly min_pass_rate: number;
  readonly case_pass_rate: number;
  readonly pass_count: number;
  readonly failures: readonly {
    readonly benchmark_id: string;
    readonly query: string;
    readonly expected_entity_id: string;
    readonly decision_status: string | null;
    readonly top_entity_id: string | null;
    readonly top_k_entities: readonly string[];
  }[];
}

interface EntityRetrievalFixtureReport {
  readonly benchmark: 'entity-retrieval-fixture';
  readonly suite_ids: readonly EntityRetrievalSuiteId[];
  readonly source: 'live-api' | 'predictions';
  readonly evaluated_at: string;
  readonly suites: readonly SuiteMetrics[];
}

function parseArgs(argv: readonly string[]): CliArgs {
  let output = DEFAULT_OUTPUT;
  let apiUrl = process.env['SEARCH_API_URL'] ?? 'http://localhost:3000';
  let predictions: string | null = null;
  let smokePredictions = false;
  let suites: readonly EntityRetrievalSuiteId[] = DEFAULT_SUITES;
  let mode: CliArgs['mode'] = 'hybrid';
  let timeoutMs = 60_000;
  let concurrency = 4;
  let executionLane: BenchmarkExecutionLane = 'public';
  let debugKey = process.env['BENCHMARK_DEBUG_KEY'] ?? process.env['HTTP_DEBUG_SECRET'];
  let useThresholds = true;
  let skipPreflight = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output' || arg === '-o') {
      output = argv[++i] ?? output;
    } else if (arg === '--api-url') {
      apiUrl = argv[++i] ?? apiUrl;
    } else if (arg === '--predictions') {
      predictions = argv[++i] ?? null;
    } else if (arg === '--smoke-predictions') {
      smokePredictions = true;
    } else if (arg === '--suite' || arg === '--suites') {
      suites = parseSuiteIdList(argv[++i], DEFAULT_SUITES) ?? DEFAULT_SUITES;
    } else if (arg === '--mode') {
      const candidate = argv[++i];
      if (candidate === 'auto' || candidate === 'hybrid' || candidate === 'entity') {
        mode = candidate;
      }
    } else if (arg === '--timeout-ms') {
      const value = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(value) && value >= 1000) timeoutMs = value;
    } else if (arg === '--concurrency') {
      const value = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(value) && value >= 1) concurrency = Math.min(16, value);
    } else if (arg === '--execution-lane') {
      const value = argv[++i];
      if (value === 'public' || value === 'trusted_benchmark') {
        executionLane = value;
      }
    } else if (arg === '--debug-key') {
      debugKey = argv[++i] ?? debugKey;
    } else if (arg === '--no-thresholds') {
      useThresholds = false;
    } else if (arg === '--skip-preflight') {
      skipPreflight = true;
    }
  }

  return {
    output,
    apiUrl,
    predictions,
    smokePredictions,
    suites,
    mode,
    timeoutMs,
    concurrency,
    executionLane,
    debugKey,
    useThresholds,
    skipPreflight,
  };
}

function hitAtK(entityIds: readonly string[], expectedEntityId: string, k: number): boolean {
  return entityIds.slice(0, k).includes(expectedEntityId);
}

function evaluateCase(
  benchmarkCase: FixtureEntityBenchmarkCase,
  prediction: RankedPrediction | undefined,
): {
  readonly pass: boolean;
  readonly top1Hit: boolean;
  readonly topKHit: boolean;
  readonly safeResponse: boolean;
  readonly wrongTop1: boolean;
  readonly wrongConfidentTop1: boolean;
  readonly predictedStatus: NoisyEntityDecisionStatus | null;
  readonly topEntityId: string | null;
  readonly topKEntityIds: readonly string[];
} {
  const rankedEntities = prediction?.rankedEntities ?? [];
  const entityIds = rankedEntities.map((item) => item.entity_id);
  const predictedStatus = prediction?.decisionStatus ?? (entityIds.length > 0 ? 'resolved' : 'failed');
  const top1Hit = hitAtK(entityIds, benchmarkCase.expected_entity_id, 1);
  const topKHit = hitAtK(entityIds, benchmarkCase.expected_entity_id, benchmarkCase.top_k);
  const topEntityId = entityIds[0] ?? null;
  const wrongTop1 = entityIds.length > 0 && !top1Hit;
  const wrongConfidentTop1 = benchmarkCase.confident_wrong_top1_forbidden
    && predictedStatus === 'resolved'
    && wrongTop1;
  const safeResponse = top1Hit || (benchmarkCase.clarify_acceptable && predictedStatus === 'ambiguous');
  const pass = benchmarkCase.suite === 'ambiguous_shortform'
    ? safeResponse && !wrongConfidentTop1
    : topKHit && !(benchmarkCase.confident_wrong_top1_forbidden && wrongTop1);

  return {
    pass,
    top1Hit,
    topKHit,
    safeResponse,
    wrongTop1,
    wrongConfidentTop1,
    predictedStatus,
    topEntityId,
    topKEntityIds: entityIds.slice(0, Math.max(benchmarkCase.top_k, 3)),
  };
}

export function scoreEntityRetrievalFixtureCases(
  cases: readonly FixtureEntityBenchmarkCase[],
  predictions: ReadonlyMap<string, RankedPrediction>,
): EntityRetrievalFixtureReport {
  const grouped = new Map<EntityRetrievalSuiteId, FixtureEntityBenchmarkCase[]>();
  for (const benchmarkCase of cases) {
    const bucket = grouped.get(benchmarkCase.suite) ?? [];
    bucket.push(benchmarkCase);
    grouped.set(benchmarkCase.suite, bucket);
  }

  const suites: SuiteMetrics[] = [];
  for (const suiteId of DEFAULT_SUITES) {
    const suiteCases = grouped.get(suiteId) ?? [];
    if (suiteCases.length === 0) continue;

    let top1Hits = 0;
    let topKHits = 0;
    let safeResponses = 0;
    let wrongTop1Count = 0;
    let wrongConfidentTop1Count = 0;
    let passCount = 0;
    const failures: SuiteMetrics['failures'] = [];

    for (const benchmarkCase of suiteCases) {
      const result = evaluateCase(benchmarkCase, predictions.get(benchmarkCase.benchmark_id));
      if (result.top1Hit) top1Hits += 1;
      if (result.topKHit) topKHits += 1;
      if (result.safeResponse) safeResponses += 1;
      if (result.wrongTop1) wrongTop1Count += 1;
      if (result.wrongConfidentTop1) wrongConfidentTop1Count += 1;
      if (result.pass) {
        passCount += 1;
      } else if (failures.length < 25) {
        failures.push({
          benchmark_id: benchmarkCase.benchmark_id,
          query: benchmarkCase.query,
          expected_entity_id: benchmarkCase.expected_entity_id,
          decision_status: result.predictedStatus,
          top_entity_id: result.topEntityId,
          top_k_entities: result.topKEntityIds,
        });
      }
    }

    const count = suiteCases.length;
    suites.push({
      suite_id: suiteId,
      query_count: count,
      top1_accuracy: suiteId === 'ambiguous_shortform' ? null : top1Hits / count,
      topk_accuracy: suiteId === 'ambiguous_shortform' ? null : topKHits / count,
      safe_response_rate: suiteId === 'ambiguous_shortform' ? safeResponses / count : null,
      wrong_top1_rate: suiteId === 'ambiguous_shortform' ? null : wrongTop1Count / count,
      wrong_confident_top1_rate: suiteId === 'ambiguous_shortform' ? wrongConfidentTop1Count / count : null,
      min_pass_rate: passCount / count,
      case_pass_rate: passCount / count,
      pass_count: passCount,
      failures,
    });
  }

  return {
    benchmark: 'entity-retrieval-fixture',
    suite_ids: suites.map((suite) => suite.suite_id),
    source: 'predictions',
    evaluated_at: new Date().toISOString(),
    suites,
  };
}

export function buildPerfectEntityRetrievalPredictions(
  cases: readonly FixtureEntityBenchmarkCase[],
): Map<string, RankedPrediction> {
  return new Map(cases.map((benchmarkCase) => [
    benchmarkCase.benchmark_id,
    {
      rankedEntities: [{ entity_id: benchmarkCase.expected_entity_id }],
      decisionStatus: benchmarkCase.expected_resolution ?? 'resolved',
    },
  ]));
}

export async function assertEntityRetrievalFixtureThresholds(
  report: EntityRetrievalFixtureReport,
): Promise<void> {
  const thresholds = await loadFixtureThresholds();
  const violations: string[] = [];

  for (const suite of report.suites) {
    const suiteThresholds = thresholds[suite.suite_id];
    if (typeof suiteThresholds !== 'object' || suiteThresholds === null) continue;
    const record = suiteThresholds as Readonly<Record<string, unknown>>;

    if (suite.top1_accuracy !== null) {
      const top1 = readNumericThreshold(record, 'top1_accuracy');
      if (top1 !== undefined && suite.top1_accuracy < top1) {
        violations.push(`${suite.suite_id}.top1_accuracy=${suite.top1_accuracy.toFixed(4)} < ${top1.toFixed(4)}`);
      }
    }

    if (suite.topk_accuracy !== null) {
      const top3 = readNumericThreshold(record, 'top3_accuracy');
      if (top3 !== undefined && suite.topk_accuracy < top3) {
        violations.push(`${suite.suite_id}.top3_accuracy=${suite.topk_accuracy.toFixed(4)} < ${top3.toFixed(4)}`);
      }
    }

    if (suite.safe_response_rate !== null) {
      const safeResponseRate = readNumericThreshold(record, 'safe_response_rate');
      if (safeResponseRate !== undefined && suite.safe_response_rate < safeResponseRate) {
        violations.push(`${suite.suite_id}.safe_response_rate=${suite.safe_response_rate.toFixed(4)} < ${safeResponseRate.toFixed(4)}`);
      }
    }

    if (suite.wrong_top1_rate !== null) {
      const wrongTop1Rate = readNumericThreshold(record, 'wrong_top1_rate');
      if (wrongTop1Rate !== undefined && suite.wrong_top1_rate > wrongTop1Rate) {
        violations.push(`${suite.suite_id}.wrong_top1_rate=${suite.wrong_top1_rate.toFixed(4)} > ${wrongTop1Rate.toFixed(4)}`);
      }
    }

    if (suite.wrong_confident_top1_rate !== null) {
      const wrongConfidentTop1Rate = readNumericThreshold(record, 'wrong_confident_top1_rate');
      if (wrongConfidentTop1Rate !== undefined && suite.wrong_confident_top1_rate > wrongConfidentTop1Rate) {
        violations.push(`${suite.suite_id}.wrong_confident_top1_rate=${suite.wrong_confident_top1_rate.toFixed(4)} > ${wrongConfidentTop1Rate.toFixed(4)}`);
      }
    }

    const minPassRate = readNumericThreshold(record, 'min_pass_rate');
    if (minPassRate !== undefined && suite.case_pass_rate < minPassRate) {
      violations.push(`${suite.suite_id}.min_pass_rate=${suite.case_pass_rate.toFixed(4)} < ${minPassRate.toFixed(4)}`);
    }
  }

  if (violations.length > 0) {
    throw new Error(`Entity retrieval fixture gate failed:\n- ${violations.join('\n- ')}`);
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadEntityRetrievalFixtureCases(args.suites);
  if (!args.smokePredictions && args.predictions === null && !args.skipPreflight) {
    await runLiveBenchmarkPreflight({
      apiUrl: args.apiUrl,
      executionLane: args.executionLane,
      debugKey: args.debugKey,
      requiredEntityIds: cases.map((item) => item.expected_entity_id),
    });
  }
  const predictions = args.smokePredictions
    ? buildPerfectEntityRetrievalPredictions(cases)
    : args.predictions !== null
    ? await loadNoisyEntityPredictions(args.predictions, new Set(cases.map((item) => item.benchmark_id)))
    : await fetchLiveRankings(
        cases,
        args.apiUrl,
        args.mode,
        args.timeoutMs,
        args.concurrency,
        args.executionLane,
        args.debugKey,
      );

  const report = scoreEntityRetrievalFixtureCases(cases, predictions);
  const finalReport: EntityRetrievalFixtureReport = {
    ...report,
    source: args.predictions !== null || args.smokePredictions ? 'predictions' : 'live-api',
    evaluated_at: new Date().toISOString(),
  };

  await fs.writeFile(args.output, `${JSON.stringify(finalReport, null, 2)}\n`, 'utf8');

  console.log('Entity retrieval fixture benchmark complete');
  for (const suite of finalReport.suites) {
    console.log(
      `  ${suite.suite_id}: n=${suite.query_count} pass=${suite.case_pass_rate.toFixed(4)}` +
      `${suite.top1_accuracy !== null ? ` top1=${suite.top1_accuracy.toFixed(4)}` : ''}` +
      `${suite.topk_accuracy !== null ? ` top3=${suite.topk_accuracy.toFixed(4)}` : ''}` +
      `${suite.safe_response_rate !== null ? ` safe=${suite.safe_response_rate.toFixed(4)}` : ''}`,
    );
  }
  console.log(`  output: ${args.output}`);

  if (args.useThresholds) {
    await assertEntityRetrievalFixtureThresholds(finalReport);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    if (err instanceof Error) {
      if (err.stack) console.error(err.stack);
      if ('cause' in err && err.cause) console.error('CAUSE:', err.cause);
    }
    process.exit(1);
  });
}
