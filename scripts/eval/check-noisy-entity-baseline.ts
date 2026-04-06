#!/usr/bin/env tsx
/**
 * Noisy Entity Baseline Checker.
 *
 * Loads smoke predictions, scores them against the benchmark, then compares
 * the resulting metrics against the baseline fixture to detect regressions.
 *
 * Exit code 1 if any metric drops below the baseline floor.
 */

import fs from 'node:fs/promises';
import {
  loadNoisyEntityBenchmark,
  loadNoisyEntityPredictions,
  scoreNoisyEntityBenchmark,
} from './run-noisy-entity-eval.js';

const DEFAULT_PREDICTIONS = 'data/noisy-entity-predictions-smoke.jsonl';
const DEFAULT_BASELINE = 'data/noisy-entity-baseline.json';

interface BaselineFixture {
  readonly version: string;
  readonly capturedAt: string;
  readonly overall: {
    readonly recall1: number;
    readonly recall3: number;
    readonly mrr: number;
    readonly falseExactMatchRate: number;
    readonly abstainPrecision: number;
  };
  readonly byCategory: Record<string, {
    readonly recall1?: number;
    readonly recall3?: number;
    readonly mrr?: number;
  }>;
  readonly note?: string;
}

interface RegressionFailure {
  readonly metric: string;
  readonly baseline: number;
  readonly actual: number;
}

function parseArgs(argv: readonly string[]): {
  predictions: string;
  baseline: string;
} {
  let predictions = DEFAULT_PREDICTIONS;
  let baseline = DEFAULT_BASELINE;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--predictions') {
      predictions = argv[++i] ?? DEFAULT_PREDICTIONS;
    } else if (arg === '--baseline') {
      baseline = argv[++i] ?? DEFAULT_BASELINE;
    }
  }

  return { predictions, baseline };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Load benchmark cases
  const cases = await loadNoisyEntityBenchmark();
  const benchmarkIds = new Set(cases.map((c) => c.benchmark_id));

  // Load predictions
  const predictions = await loadNoisyEntityPredictions(args.predictions, benchmarkIds);

  // Score
  const report = scoreNoisyEntityBenchmark(cases, predictions);

  // Load baseline fixture
  const baselineRaw = await fs.readFile(args.baseline, 'utf8');
  const baseline = JSON.parse(baselineRaw) as BaselineFixture;

  // Compare overall metrics against baseline floors
  const failures: RegressionFailure[] = [];

  if (report.recall_at_1 < baseline.overall.recall1) {
    failures.push({
      metric: 'overall.recall1',
      baseline: baseline.overall.recall1,
      actual: report.recall_at_1,
    });
  }

  if (report.recall_at_3 < baseline.overall.recall3) {
    failures.push({
      metric: 'overall.recall3',
      baseline: baseline.overall.recall3,
      actual: report.recall_at_3,
    });
  }

  if (report.mrr < baseline.overall.mrr) {
    failures.push({
      metric: 'overall.mrr',
      baseline: baseline.overall.mrr,
      actual: report.mrr,
    });
  }

  const actualFalseExact = report.false_exact_rate ?? 0;
  if (actualFalseExact > baseline.overall.falseExactMatchRate) {
    failures.push({
      metric: 'overall.falseExactMatchRate',
      baseline: baseline.overall.falseExactMatchRate,
      actual: actualFalseExact,
    });
  }

  // Compare per-category metrics if baseline specifies them
  for (const [category, categoryBaseline] of Object.entries(baseline.byCategory)) {
    const categoryReport = report.by_category[category];
    if (categoryReport === undefined) {
      continue;
    }

    if (categoryBaseline.recall1 !== undefined && categoryReport.recall_at_1 < categoryBaseline.recall1) {
      failures.push({
        metric: `byCategory.${category}.recall1`,
        baseline: categoryBaseline.recall1,
        actual: categoryReport.recall_at_1,
      });
    }

    if (categoryBaseline.recall3 !== undefined && categoryReport.recall_at_3 < categoryBaseline.recall3) {
      failures.push({
        metric: `byCategory.${category}.recall3`,
        baseline: categoryBaseline.recall3,
        actual: categoryReport.recall_at_3,
      });
    }

    if (categoryBaseline.mrr !== undefined && categoryReport.mrr < categoryBaseline.mrr) {
      failures.push({
        metric: `byCategory.${category}.mrr`,
        baseline: categoryBaseline.mrr,
        actual: categoryReport.mrr,
      });
    }
  }

  // Print summary report
  console.log('=== Noisy Entity Baseline Check ===');
  console.log(`  baseline version: ${baseline.version}`);
  console.log(`  baseline captured: ${baseline.capturedAt}`);
  console.log(`  predictions: ${args.predictions}`);
  console.log('');
  console.log('--- Current Metrics ---');
  console.log(`  recall@1:            ${report.recall_at_1.toFixed(4)}`);
  console.log(`  recall@3:            ${report.recall_at_3.toFixed(4)}`);
  console.log(`  mrr:                 ${report.mrr.toFixed(4)}`);
  console.log(`  false_exact_rate:    ${actualFalseExact.toFixed(4)}`);
  console.log(`  query_count:         ${report.query_count}`);
  console.log('');
  console.log('--- Baseline Floors ---');
  console.log(`  recall@1:            ${baseline.overall.recall1.toFixed(4)}`);
  console.log(`  recall@3:            ${baseline.overall.recall3.toFixed(4)}`);
  console.log(`  mrr:                 ${baseline.overall.mrr.toFixed(4)}`);
  console.log(`  false_exact_rate:    ${baseline.overall.falseExactMatchRate.toFixed(4)}`);
  console.log('');

  if (failures.length > 0) {
    console.error('--- REGRESSIONS DETECTED ---');
    for (const failure of failures) {
      console.error(`  FAIL: ${failure.metric} — baseline=${failure.baseline.toFixed(4)} actual=${failure.actual.toFixed(4)}`);
    }
    console.error('');
    console.error(`${failures.length} metric(s) below baseline. Failing.`);
    process.exitCode = 1;
    return;
  }

  console.log('--- Result: PASSED ---');
  console.log('All metrics meet or exceed baseline floors.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
