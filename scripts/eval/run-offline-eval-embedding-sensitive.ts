#!/usr/bin/env tsx
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config/env.js';
import { createPgPool, shouldUsePgPool } from '../../src/infrastructure/db/pg-pool.js';
import { loadSearchSnapshotRuntimeState } from '../../src/infrastructure/health/search-snapshot-readiness.js';
import { buildEmbeddingSensitiveHumanGoldCorpus } from './build-embedding-sensitive-human-gold-corpus.js';
import { resolveCliDataPathArg } from './cli-data-path.js';
import {
  applyResolvedHumanGoldRuntimeEntityIds,
  assertHumanGoldRuntimeCoverage,
  collectHumanGoldCatalogRows,
  loadHumanGoldCatalogLookup,
  resolveHumanGoldRuntimeEntityIds,
  summarizeHumanGoldRuntimeCoverage,
} from './embedding-sensitive-human-gold-runtime-corpus.js';
import { isLocalApiUrl } from './live-benchmark-preflight.js';
import type { GoldenQuery } from '../etl/types.js';

interface Args {
  readonly input?: string;
  readonly fixtureCorpus?: 'silver' | 'val' | 'gate' | 'release_silver' | 'release_gold';
  readonly output: string;
  readonly denseOffOutput: string;
  readonly ablationOutput: string;
  readonly baselineReport?: string;
  readonly tier: 'bronze' | 'silver';
  readonly compareDenseOff: boolean;
  readonly apiUrl: string;
  readonly denseOffApiUrl?: string;
}

interface OfflineEvalReport {
  readonly query_count: number;
  readonly ndcg_at_10: number;
  readonly mrr_at_10: number;
  readonly recall_at_3?: number;
  readonly recall_at_100?: number;
  readonly decision_utility: number;
  readonly wrong_top1_rate: number;
  readonly provenance?: Readonly<Record<string, unknown>>;
}

interface EmbeddingAblationReport {
  readonly dense_on_path: string;
  readonly dense_off_path: string;
  readonly dense_on_query_count: number;
  readonly dense_off_query_count: number;
  readonly deltas_dense_on_minus_dense_off: {
    readonly ndcg_at_10: number;
    readonly mrr_at_10: number;
    readonly recall_at_3: number | null;
    readonly recall_at_100: number | null;
    readonly decision_utility: number;
    readonly wrong_top1_rate: number;
  };
  readonly dense_on_provenance?: Readonly<Record<string, unknown>>;
  readonly dense_off_provenance?: Readonly<Record<string, unknown>>;
}

function parseArgs(argv: readonly string[]): Args {
  let input: string | undefined;
  let fixtureCorpus: Args['fixtureCorpus'];
  let output = '/tmp/offline-eval-embedding-sensitive-results.json';
  let denseOffOutput = '/tmp/offline-eval-embedding-sensitive-dense-off-results.json';
  let ablationOutput = '/tmp/offline-eval-embedding-sensitive-ablation.json';
  let baselineReport: string | undefined;
  let tier: Args['tier'] = 'bronze';
  let compareDenseOff = false;
  let apiUrl = process.env['SEARCH_API_URL']?.trim() || 'http://127.0.0.1:3000';
  let denseOffApiUrl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input' || arg === '-i') {
      input = resolveCliDataPathArg(argv[++index] ?? '');
    } else if (arg === '--fixture-corpus') {
      const value = argv[++index];
      if (
        value === 'silver'
        || value === 'val'
        || value === 'gate'
        || value === 'release_silver'
        || value === 'release_gold'
      ) {
        fixtureCorpus = value;
      }
    } else if (arg === '--output' || arg === '-o') {
      output = resolveCliDataPathArg(argv[++index] ?? output);
    } else if (arg === '--dense-off-output') {
      denseOffOutput = resolveCliDataPathArg(argv[++index] ?? denseOffOutput);
    } else if (arg === '--ablation-output') {
      ablationOutput = resolveCliDataPathArg(argv[++index] ?? ablationOutput);
    } else if (arg === '--baseline-report') {
      baselineReport = resolveCliDataPathArg(argv[++index] ?? '');
    } else if (arg === '--tier') {
      const value = argv[++index];
      if (value === 'bronze' || value === 'silver') {
        tier = value;
      }
    } else if (arg === '--compare-dense-off') {
      compareDenseOff = true;
    } else if (arg === '--api-url' || arg === '--dense-on-api-url') {
      apiUrl = argv[++index]?.trim() || apiUrl;
    } else if (arg === '--dense-off-api-url') {
      denseOffApiUrl = argv[++index]?.trim() || undefined;
    }
  }

  return {
    input,
    fixtureCorpus,
    output,
    denseOffOutput,
    ablationOutput,
    baselineReport,
    tier,
    compareDenseOff,
    apiUrl,
    denseOffApiUrl,
  };
}

function normalizeApiUrl(url: string): string {
  return new URL(url).toString();
}

export function assertEmbeddingAblationTargets(args: {
  readonly apiUrl: string;
  readonly denseOffApiUrl?: string;
  readonly compareDenseOff: boolean;
}): void {
  if (!args.compareDenseOff) {
    return;
  }
  if ((args.denseOffApiUrl?.trim().length ?? 0) === 0) {
    throw new Error(
      'embedding-sensitive dense ablation requires --dense-off-api-url. ' +
      'Dense-on and dense-off must target different live search runtimes.',
    );
  }
  const denseOnUrl = normalizeApiUrl(args.apiUrl);
  const denseOffUrl = normalizeApiUrl(args.denseOffApiUrl!);
  if (denseOnUrl === denseOffUrl) {
    throw new Error(
      'embedding-sensitive dense ablation requires different live runtime URLs for dense-on and dense-off. ' +
      `both resolved to ${denseOnUrl}`,
    );
  }
}

function buildRunnerArgs(
  args: Args,
  outputPath: string,
  preparedInputPath?: string,
): readonly string[] {
  const runnerArgs = [
    path.resolve(process.cwd(), 'scripts/eval/run-offline-eval.ts'),
    '--output',
    outputPath,
    '--tier',
    args.tier,
    '--include-diagnostics',
    '--embedding-sensitive-only',
  ];

  if (preparedInputPath !== undefined) {
    runnerArgs.push('--input', preparedInputPath);
  } else if (args.fixtureCorpus !== undefined) {
    runnerArgs.push('--fixture-corpus', args.fixtureCorpus);
  } else if (args.input !== undefined) {
    runnerArgs.push('--input', args.input);
  } else {
    throw new Error(
      'embedding-sensitive offline eval requires either an explicit input, a fixture corpus, or a generated human-gold corpus.',
    );
  }

  if (args.baselineReport !== undefined) {
    runnerArgs.push('--baseline-report', args.baselineReport);
  }

  return runnerArgs;
}

function buildEmbeddingAblationReport(args: {
  readonly denseOnPath: string;
  readonly denseOffPath: string;
  readonly denseOn: OfflineEvalReport;
  readonly denseOff: OfflineEvalReport;
}): EmbeddingAblationReport {
  return {
    dense_on_path: args.denseOnPath,
    dense_off_path: args.denseOffPath,
    dense_on_query_count: args.denseOn.query_count,
    dense_off_query_count: args.denseOff.query_count,
    deltas_dense_on_minus_dense_off: {
      ndcg_at_10: args.denseOn.ndcg_at_10 - args.denseOff.ndcg_at_10,
      mrr_at_10: args.denseOn.mrr_at_10 - args.denseOff.mrr_at_10,
      recall_at_3:
        args.denseOn.recall_at_3 !== undefined && args.denseOff.recall_at_3 !== undefined
          ? args.denseOn.recall_at_3 - args.denseOff.recall_at_3
          : null,
      recall_at_100:
        args.denseOn.recall_at_100 !== undefined && args.denseOff.recall_at_100 !== undefined
          ? args.denseOn.recall_at_100 - args.denseOff.recall_at_100
          : null,
      decision_utility: args.denseOn.decision_utility - args.denseOff.decision_utility,
      wrong_top1_rate: args.denseOn.wrong_top1_rate - args.denseOff.wrong_top1_rate,
    },
    dense_on_provenance: args.denseOn.provenance,
    dense_off_provenance: args.denseOff.provenance,
  };
}

interface ReadySnapshotResponse {
  readonly snapshot_health?: {
    readonly active_snapshot_id?: string | undefined;
  } | undefined;
}

async function resolveTargetSnapshotId(apiUrl: string): Promise<string> {
  const response = await fetch(`${apiUrl}/ready`, {
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
  if (response?.ok) {
    const body = (await response.json()) as ReadySnapshotResponse;
    const snapshotId = body.snapshot_health?.active_snapshot_id?.trim();
    if ((snapshotId?.length ?? 0) > 0) {
      return snapshotId!;
    }
  }

  if (!isLocalApiUrl(apiUrl)) {
    throw new Error(
      'embedding-sensitive human-gold auto-corpus requires a local live runtime that exposes snapshot_health.active_snapshot_id, or an explicit --input/--fixture-corpus.',
    );
  }

  return (await loadSearchSnapshotRuntimeState()).snapshotId;
}

async function buildSnapshotBoundHumanGoldCorpus(args: {
  readonly apiUrl: string;
}): Promise<readonly GoldenQuery[]> {
  const queries = await buildEmbeddingSensitiveHumanGoldCorpus();
  const snapshotId = await resolveTargetSnapshotId(args.apiUrl);
  const config = loadConfig();
  if (!shouldUsePgPool(config.pg)) {
    throw new Error(
      'embedding-sensitive human-gold runtime coverage requires Postgres config when targeting a live runtime.',
    );
  }

  const pool = createPgPool(config.pg);
  try {
    const catalogLookup = await loadHumanGoldCatalogLookup();
    const catalogRows = collectHumanGoldCatalogRows({
      queries,
      catalogLookup,
    });
    const resolution = await resolveHumanGoldRuntimeEntityIds(pool, snapshotId, catalogRows);
    const summary = summarizeHumanGoldRuntimeCoverage({
      queries,
      snapshotId,
      resolution,
    });
    assertHumanGoldRuntimeCoverage(summary);
    return applyResolvedHumanGoldRuntimeEntityIds(queries, resolution.resolvedIds);
  } finally {
    await pool.end();
  }
}

async function prepareEmbeddingSensitiveInput(args: Args): Promise<string | undefined> {
  if (args.input !== undefined) {
    return args.input;
  }
  if (args.fixtureCorpus !== undefined) {
    return undefined;
  }

  const outputPath = path.join(
    '/tmp',
    `embedding-sensitive-human-gold-corpus-${process.pid}.jsonl`,
  );
  const queries = await buildSnapshotBoundHumanGoldCorpus({
    apiUrl: args.apiUrl,
  });
  await fs.writeFile(
    outputPath,
    queries.map((query) => JSON.stringify(query)).join('\n') + '\n',
    'utf8',
  );
  process.stdout.write(
    `embedding-sensitive corpus: human-gold snapshot-bound ${queries.length} queries -> ${outputPath}\n`,
  );
  return outputPath;
}

async function runChild(
  args: readonly string[],
  envOverrides: Readonly<Record<string, string>>,
): Promise<void> {
  const child = spawn(
    'pnpm',
    ['exec', 'tsx', ...args],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        ...envOverrides,
      },
    },
  );
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(`embedding-sensitive offline eval child failed with exit code ${exitCode}`);
  }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  assertEmbeddingAblationTargets(args);
  const inputPath = await prepareEmbeddingSensitiveInput(args);
  const runnerArgs = buildRunnerArgs(args, args.output, inputPath);
  await runChild(runnerArgs, {
    EVAL_RUNTIME_TARGET: 'search_api_http_embedding_sensitive',
    EVAL_EXPECT_DENSE_RETRIEVAL_ENABLED: 'true',
    EVAL_EMBEDDING_SENSITIVE_PHASE: 'dense_on',
    SEARCH_API_URL: args.apiUrl,
    EVAL_SKIP_EMBEDDING_VALIDATION: 'true',
  });

  if (!args.compareDenseOff) {
    return;
  }

  const denseOffRunnerArgs = buildRunnerArgs(args, args.denseOffOutput, inputPath);
  await runChild(denseOffRunnerArgs, {
    EVAL_RUNTIME_TARGET: 'search_api_http_embedding_sensitive_dense_off',
    EVAL_EXPECT_DENSE_RETRIEVAL_ENABLED: 'false',
    EVAL_EMBEDDING_SENSITIVE_PHASE: 'dense_off',
    SEARCH_API_URL: args.denseOffApiUrl!,
    EVAL_SKIP_EMBEDDING_VALIDATION: 'true',
  });

  const [denseOnRaw, denseOffRaw] = await Promise.all([
    fs.readFile(args.output, 'utf8'),
    fs.readFile(args.denseOffOutput, 'utf8'),
  ]);
  const denseOn = JSON.parse(denseOnRaw) as OfflineEvalReport;
  const denseOff = JSON.parse(denseOffRaw) as OfflineEvalReport;
  const ablation = buildEmbeddingAblationReport({
    denseOnPath: args.output,
    denseOffPath: args.denseOffOutput,
    denseOn,
    denseOff,
  });
  await fs.writeFile(args.ablationOutput, JSON.stringify(ablation, null, 2) + '\n', 'utf8');
  process.stdout.write(
    [
      '',
      '=== EMBEDDING-SENSITIVE DENSE ABLATION ===',
      `  dense_on:      ${args.output}`,
      `  dense_off:     ${args.denseOffOutput}`,
      `  ablation:      ${args.ablationOutput}`,
      `  ndcg@10 Δ:     ${ablation.deltas_dense_on_minus_dense_off.ndcg_at_10.toFixed(4)}`,
      `  mrr@10 Δ:      ${ablation.deltas_dense_on_minus_dense_off.mrr_at_10.toFixed(4)}`,
      `  recall@3 Δ:    ${ablation.deltas_dense_on_minus_dense_off.recall_at_3?.toFixed(4) ?? 'n/a'}`,
      `  recall@100 Δ:  ${ablation.deltas_dense_on_minus_dense_off.recall_at_100?.toFixed(4) ?? 'n/a'}`,
      `  utility Δ:     ${ablation.deltas_dense_on_minus_dense_off.decision_utility.toFixed(4)}`,
      `  wrongTop1 Δ:   ${ablation.deltas_dense_on_minus_dense_off.wrong_top1_rate.toFixed(4)}`,
      '',
    ].join('\n'),
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  void run()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`FATAL: ${message}`);
      process.exit(1);
    });
}

export { buildEmbeddingAblationReport };
