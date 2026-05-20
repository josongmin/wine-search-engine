#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { resolveDataPath } from '../../src/domain/shared/utils/data-paths.js';
import { resolveCliDataPathArg } from './cli-data-path.js';

const OfflineEvalSchema = z.object({
  dataset_tier: z.string().min(1),
  query_count: z.number().nonnegative(),
  ndcg_at_10: z.number(),
  mrr_at_10: z.number(),
  recall_at_3: z.number().optional(),
  recall_at_100: z.number().optional(),
  wrong_top1_rate: z.number(),
  by_mode: z.record(z.object({
    retrieval_mode: z.string().min(1),
    query_count: z.number().nonnegative(),
    ndcg_at_10: z.number(),
    mrr_at_10: z.number(),
    recall_at_10: z.number(),
    wrong_top1_rate: z.number(),
    decision_utility: z.number(),
  }).passthrough()).optional(),
  by_scenario: z.record(z.object({
    query_count: z.number().nonnegative(),
    ndcg_at_10: z.number(),
    mrr_at_10: z.number(),
    wrong_top1_rate: z.number(),
    decision_utility: z.number(),
  })).optional(),
  by_language: z.record(z.object({
    query_count: z.number().nonnegative(),
    ndcg_at_10: z.number(),
    mrr_at_10: z.number(),
    wrong_top1_rate: z.number(),
    decision_utility: z.number(),
  })).optional(),
});

const NoisyEvalSchema = z.object({
  benchmark: z.literal('noisy-entity-benchmark'),
  query_count: z.number().nonnegative(),
  recall_at_1: z.number(),
  recall_at_3: z.number(),
  mrr: z.number(),
  false_exact_rate: z.number().nullable().optional(),
});

const BaselineManifestSchema = z.object({
  version: z.string().min(1),
  created_at: z.string().min(1),
  baselines: z.object({
    offline_bronze: z.string().min(1),
    noisy_entity_smoke: z.string().min(1),
  }),
  thresholds: z.object({
    offline: z.object({
      ndcg_at_10_max_drop: z.number().nonnegative(),
      mrr_at_10_max_drop: z.number().nonnegative(),
      recall_at_3_max_drop: z.number().nonnegative(),
      recall_at_100_max_drop: z.number().nonnegative().optional(),
      wrong_top1_rate_max_increase: z.number().nonnegative(),
    }),
    noisy: z.object({
      recall_at_3_max_drop: z.number().nonnegative(),
      mrr_max_drop: z.number().nonnegative(),
      false_exact_rate_max_increase: z.number().nonnegative(),
    }),
  }),
});

export type OfflineEvalReport = z.infer<typeof OfflineEvalSchema>;
export type NoisyEvalReport = z.infer<typeof NoisyEvalSchema>;
export type BaselineManifest = z.infer<typeof BaselineManifestSchema>;

export interface RegressionViolation {
  readonly metric: string;
  readonly baseline: number;
  readonly current: number;
  readonly message: string;
}

const DEFAULT_MANIFEST = resolveDataPath('data/eval-baselines/manifest.json');

interface CliArgs {
  kind: 'offline' | 'noisy';
  current: string;
  baseline?: string;
  manifest: string;
}

export function compareOfflineRegression(
  current: OfflineEvalReport,
  baseline: OfflineEvalReport,
  thresholds: BaselineManifest['thresholds']['offline'],
): readonly RegressionViolation[] {
  const violations: RegressionViolation[] = [];

  if (current.ndcg_at_10 < baseline.ndcg_at_10 - thresholds.ndcg_at_10_max_drop) {
    violations.push({
      metric: 'ndcg_at_10',
      baseline: baseline.ndcg_at_10,
      current: current.ndcg_at_10,
      message: `ndcg_at_10 dropped by ${(baseline.ndcg_at_10 - current.ndcg_at_10).toFixed(4)} (> ${thresholds.ndcg_at_10_max_drop.toFixed(4)})`,
    });
  }

  if (current.mrr_at_10 < baseline.mrr_at_10 - thresholds.mrr_at_10_max_drop) {
    violations.push({
      metric: 'mrr_at_10',
      baseline: baseline.mrr_at_10,
      current: current.mrr_at_10,
      message: `mrr_at_10 dropped by ${(baseline.mrr_at_10 - current.mrr_at_10).toFixed(4)} (> ${thresholds.mrr_at_10_max_drop.toFixed(4)})`,
    });
  }

  if (current.recall_at_3 !== undefined && baseline.recall_at_3 !== undefined) {
    if (current.recall_at_3 < baseline.recall_at_3 - thresholds.recall_at_3_max_drop) {
      violations.push({
        metric: 'recall_at_3',
        baseline: baseline.recall_at_3,
        current: current.recall_at_3,
        message: `recall_at_3 dropped by ${(baseline.recall_at_3 - current.recall_at_3).toFixed(4)} (> ${thresholds.recall_at_3_max_drop.toFixed(4)})`,
      });
    }
  } else if (
    thresholds.recall_at_100_max_drop !== undefined
    && current.recall_at_100 !== undefined
    && baseline.recall_at_100 !== undefined
    && current.recall_at_100 < baseline.recall_at_100 - thresholds.recall_at_100_max_drop
  ) {
    violations.push({
      metric: 'recall_at_100',
      baseline: baseline.recall_at_100,
      current: current.recall_at_100,
      message: `recall_at_100 dropped by ${(baseline.recall_at_100 - current.recall_at_100).toFixed(4)} (> ${thresholds.recall_at_100_max_drop.toFixed(4)})`,
    });
  }

  if (current.wrong_top1_rate > baseline.wrong_top1_rate + thresholds.wrong_top1_rate_max_increase) {
    violations.push({
      metric: 'wrong_top1_rate',
      baseline: baseline.wrong_top1_rate,
      current: current.wrong_top1_rate,
      message: `wrong_top1_rate increased by ${(current.wrong_top1_rate - baseline.wrong_top1_rate).toFixed(4)} (> ${thresholds.wrong_top1_rate_max_increase.toFixed(4)})`,
    });
  }

  const compareSlices = (
    currentSlices:
      | OfflineEvalReport['by_scenario']
      | OfflineEvalReport['by_language']
      | OfflineEvalReport['by_mode']
      | undefined,
    baselineSlices:
      | OfflineEvalReport['by_scenario']
      | OfflineEvalReport['by_language']
      | OfflineEvalReport['by_mode']
      | undefined,
    prefix: 'scenario' | 'language' | 'mode',
  ): void => {
    if (currentSlices === undefined || baselineSlices === undefined) {
      return;
    }

    for (const [sliceName, baselineSlice] of Object.entries(baselineSlices)) {
      const currentSlice = currentSlices[sliceName];
      if (currentSlice === undefined) {
        continue;
      }

      if (currentSlice.ndcg_at_10 < baselineSlice.ndcg_at_10 - thresholds.ndcg_at_10_max_drop) {
        violations.push({
          metric: `${prefix}.${sliceName}.ndcg_at_10`,
          baseline: baselineSlice.ndcg_at_10,
          current: currentSlice.ndcg_at_10,
          message: `${prefix} ${sliceName} ndcg_at_10 dropped by ${(baselineSlice.ndcg_at_10 - currentSlice.ndcg_at_10).toFixed(4)} (> ${thresholds.ndcg_at_10_max_drop.toFixed(4)})`,
        });
      }

      if (currentSlice.mrr_at_10 < baselineSlice.mrr_at_10 - thresholds.mrr_at_10_max_drop) {
        violations.push({
          metric: `${prefix}.${sliceName}.mrr_at_10`,
          baseline: baselineSlice.mrr_at_10,
          current: currentSlice.mrr_at_10,
          message: `${prefix} ${sliceName} mrr_at_10 dropped by ${(baselineSlice.mrr_at_10 - currentSlice.mrr_at_10).toFixed(4)} (> ${thresholds.mrr_at_10_max_drop.toFixed(4)})`,
        });
      }

      if (currentSlice.wrong_top1_rate > baselineSlice.wrong_top1_rate + thresholds.wrong_top1_rate_max_increase) {
        violations.push({
          metric: `${prefix}.${sliceName}.wrong_top1_rate`,
          baseline: baselineSlice.wrong_top1_rate,
          current: currentSlice.wrong_top1_rate,
          message: `${prefix} ${sliceName} wrong_top1_rate increased by ${(currentSlice.wrong_top1_rate - baselineSlice.wrong_top1_rate).toFixed(4)} (> ${thresholds.wrong_top1_rate_max_increase.toFixed(4)})`,
        });
      }

      if (
        prefix === 'mode'
        && 'recall_at_10' in baselineSlice
        && 'recall_at_10' in currentSlice
        && typeof baselineSlice.recall_at_10 === 'number'
        && typeof currentSlice.recall_at_10 === 'number'
        && currentSlice.recall_at_10 < baselineSlice.recall_at_10 - thresholds.recall_at_3_max_drop
      ) {
        violations.push({
          metric: `${prefix}.${sliceName}.recall_at_10`,
          baseline: baselineSlice.recall_at_10,
          current: currentSlice.recall_at_10,
          message: `${prefix} ${sliceName} recall_at_10 dropped by ${(baselineSlice.recall_at_10 - currentSlice.recall_at_10).toFixed(4)} (> ${thresholds.recall_at_3_max_drop.toFixed(4)})`,
        });
      }
    }
  };

  compareSlices(current.by_scenario, baseline.by_scenario, 'scenario');
  compareSlices(current.by_language, baseline.by_language, 'language');
  compareSlices(current.by_mode, baseline.by_mode, 'mode');

  return violations;
}

export function compareNoisyRegression(
  current: NoisyEvalReport,
  baseline: NoisyEvalReport,
  thresholds: BaselineManifest['thresholds']['noisy'],
): readonly RegressionViolation[] {
  const violations: RegressionViolation[] = [];

  if (current.recall_at_3 < baseline.recall_at_3 - thresholds.recall_at_3_max_drop) {
    violations.push({
      metric: 'recall_at_3',
      baseline: baseline.recall_at_3,
      current: current.recall_at_3,
      message: `recall_at_3 dropped by ${(baseline.recall_at_3 - current.recall_at_3).toFixed(4)} (> ${thresholds.recall_at_3_max_drop.toFixed(4)})`,
    });
  }

  if (current.mrr < baseline.mrr - thresholds.mrr_max_drop) {
    violations.push({
      metric: 'mrr',
      baseline: baseline.mrr,
      current: current.mrr,
      message: `mrr dropped by ${(baseline.mrr - current.mrr).toFixed(4)} (> ${thresholds.mrr_max_drop.toFixed(4)})`,
    });
  }

  const baselineFalseExact = baseline.false_exact_rate ?? 0;
  const currentFalseExact = current.false_exact_rate ?? 0;
  if (currentFalseExact > baselineFalseExact + thresholds.false_exact_rate_max_increase) {
    violations.push({
      metric: 'false_exact_rate',
      baseline: baselineFalseExact,
      current: currentFalseExact,
      message: `false_exact_rate increased by ${(currentFalseExact - baselineFalseExact).toFixed(4)} (> ${thresholds.false_exact_rate_max_increase.toFixed(4)})`,
    });
  }

  return violations;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let kind: CliArgs['kind'] | null = null;
  let current = '';
  let baseline: string | undefined;
  let manifest = DEFAULT_MANIFEST;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--kind') {
      const value = argv[++i];
      if (value === 'offline' || value === 'noisy') {
        kind = value;
      }
    } else if (arg === '--current') {
      current = resolveCliDataPathArg(argv[++i] ?? '');
    } else if (arg === '--baseline') {
      const baselinePath = argv[++i];
      baseline = baselinePath === undefined ? '' : resolveCliDataPathArg(baselinePath);
    } else if (arg === '--manifest') {
      manifest = resolveCliDataPathArg(argv[++i] ?? DEFAULT_MANIFEST);
    }
  }

  if (kind === null || current.length === 0) {
    throw new Error('Usage: tsx scripts/eval/assert-baseline-regression.ts --kind <offline|noisy> --current <path> [--baseline <path>] [--manifest <path>]');
  }

  return { kind, current, baseline, manifest };
}

async function readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return schema.parse(JSON.parse(raw) as unknown);
}

async function readManifest(manifestPath: string): Promise<BaselineManifest> {
  return readJson(manifestPath, BaselineManifestSchema);
}

function resolveBaselinePath(
  kind: CliArgs['kind'],
  manifest: BaselineManifest,
  manifestPath: string,
  explicitBaseline?: string,
): string {
  if (explicitBaseline !== undefined && explicitBaseline.length > 0) {
    return explicitBaseline;
  }

  const baselinePath = kind === 'offline'
    ? manifest.baselines.offline_bronze
    : manifest.baselines.noisy_entity_smoke;

  return path.resolve(path.dirname(manifestPath), '..', baselinePath.replace(/^data\//, ''));
}

function printViolations(violations: readonly RegressionViolation[]): void {
  for (const violation of violations) {
    console.error(
      `  - ${violation.metric}: baseline=${violation.baseline.toFixed(4)} current=${violation.current.toFixed(4)} :: ${violation.message}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readManifest(args.manifest);
  const baselinePath = resolveBaselinePath(args.kind, manifest, args.manifest, args.baseline);

  if (args.kind === 'offline') {
    const current = await readJson(args.current, OfflineEvalSchema);
    const baseline = await readJson(baselinePath, OfflineEvalSchema);
    const violations = compareOfflineRegression(current, baseline, manifest.thresholds.offline);

    console.log('Offline baseline regression check');
    console.log(`  current:  ${args.current}`);
    console.log(`  baseline: ${baselinePath}`);

    if (violations.length > 0) {
      console.error('  status: FAILED');
      printViolations(violations);
      process.exitCode = 1;
      return;
    }

    console.log('  status: PASSED');
    return;
  }

  const current = await readJson(args.current, NoisyEvalSchema);
  const baseline = await readJson(baselinePath, NoisyEvalSchema);
  const violations = compareNoisyRegression(current, baseline, manifest.thresholds.noisy);

  console.log('Noisy benchmark regression check');
  console.log(`  current:  ${args.current}`);
  console.log(`  baseline: ${baselinePath}`);

  if (violations.length > 0) {
    console.error('  status: FAILED');
    printViolations(violations);
    process.exitCode = 1;
    return;
  }

  console.log('  status: PASSED');
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
