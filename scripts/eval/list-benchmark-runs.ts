#!/usr/bin/env tsx
/**
 * CLI to query and display eval_benchmark_runs from the ledger.
 *
 * Usage:
 *   pnpm exec tsx scripts/eval/list-benchmark-runs.ts
 *   pnpm exec tsx scripts/eval/list-benchmark-runs.ts --kind offline_eval
 *   pnpm exec tsx scripts/eval/list-benchmark-runs.ts --since 2026-04-01 --kind noisy_entity
 *   pnpm exec tsx scripts/eval/list-benchmark-runs.ts --snapshot-id snap-v42 --limit 10
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local', override: true });
dotenv.config();

import { Pool } from 'pg';
import { createScriptPgPool } from '../lib/script-pg-pool.js';
import type { EvalBenchmarkKind } from '../../src/domain/evaluation/model/eval-benchmark-run.js';
import { PgEvalBenchmarkRunStore } from '../../src/infrastructure/adapter/pg-eval-benchmark-run-store.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

const VALID_KINDS = new Set<string>([
  'noisy_entity',
  'offline_eval',
  'offline_eval_in_memory_regression',
  'offline_eval_live_runtime',
  'offline_eval_embedding_sensitive_live_runtime',
  'entity_retrieval_fixture',
  'search_feature_behavior_fixture',
  'search_feature_behavior_structural',
  'search_feature_behavior_live',
  'agentic_tool_use_fixture',
]);

interface CliArgs {
  readonly kind?: EvalBenchmarkKind;
  readonly snapshotId?: string;
  readonly since?: Date;
  readonly limit: number;
  readonly includeLegacy: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let kind: EvalBenchmarkKind | undefined;
  let snapshotId: string | undefined;
  let since: Date | undefined;
  let limit = DEFAULT_LIMIT;
  let includeLegacy = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--kind' || arg === '-k') {
      const value = argv[++i];
      if (value !== undefined && VALID_KINDS.has(value)) {
        kind = value as EvalBenchmarkKind;
      } else {
        console.error(`Invalid --kind value: ${value ?? '(missing)'}`);
        console.error(`Valid kinds: ${Array.from(VALID_KINDS).join(', ')}`);
        process.exit(1);
      }
    } else if (arg === '--snapshot-id' || arg === '-s') {
      snapshotId = argv[++i];
      if (snapshotId === undefined) {
        console.error('Missing value for --snapshot-id');
        process.exit(1);
      }
    } else if (arg === '--since') {
      const raw = argv[++i];
      if (raw === undefined) {
        console.error('Missing value for --since');
        process.exit(1);
      }
      const parsed = new Date(raw);
      if (!Number.isFinite(parsed.getTime())) {
        console.error(`Invalid --since date: ${raw}`);
        process.exit(1);
      }
      since = parsed;
    } else if (arg === '--limit' || arg === '-n') {
      const value = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(value) && value >= 1) {
        limit = Math.min(MAX_LIMIT, value);
      }
    } else if (arg === '--include-legacy') {
      includeLegacy = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return { kind, snapshotId, since, limit, includeLegacy };
}

function printUsage(): void {
  console.log(`Usage: pnpm exec tsx scripts/eval/list-benchmark-runs.ts [options]

Options:
  --kind, -k <kind>           Filter by benchmark kind
  --snapshot-id, -s <id>      Filter by search snapshot ID
  --since <ISO date>          Show runs created after this date
  --limit, -n <N>             Max rows to display (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})
  --include-legacy            Include pre-provenance legacy rows
  --help, -h                  Show this help

Valid kinds: ${Array.from(VALID_KINDS).join(', ')}

Examples:
  pnpm exec tsx scripts/eval/list-benchmark-runs.ts
  pnpm exec tsx scripts/eval/list-benchmark-runs.ts --kind offline_eval
  pnpm exec tsx scripts/eval/list-benchmark-runs.ts --since 2026-04-01 --kind noisy_entity
`);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}\u2026` : value;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function formatDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function createPool(): Pool {
  return createScriptPgPool();
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = createPool();

  try {
    const store = new PgEvalBenchmarkRunStore(pool);
    const runs = await store.listRuns({
      benchmarkKind: args.kind,
      snapshotId: args.snapshotId,
      since: args.since,
      limit: args.limit,
      includeLegacy: args.includeLegacy,
    });

    if (runs.length === 0) {
      console.log('No benchmark runs found matching the given filters.');
      return;
    }

    // Column widths
    const colRunId = 16;
    const colKind = 38;
    const colSnapshot = 14;
    const colRuntime = 20;
    const colQueries = 8;
    const colGate = 6;

    const header =
      padRight('RUN_ID', colRunId) +
      padRight('KIND', colKind) +
      padRight('SNAPSHOT', colSnapshot) +
      padRight('RUNTIME', colRuntime) +
      padRight('QUERIES', colQueries) +
      padRight('GATE', colGate) +
      'CREATED';
    const separator = '-'.repeat(header.length);

    console.log(header);
    console.log(separator);

    for (const run of runs) {
      const line =
        padRight(truncate(run.runId, colRunId), colRunId) +
        padRight(truncate(run.benchmarkKind, colKind), colKind) +
        padRight(truncate(run.snapshotId ?? '-', colSnapshot), colSnapshot) +
        padRight(truncate(run.provenance?.runtimeTarget ?? 'legacy', colRuntime), colRuntime) +
        padRight(String(run.queryCount), colQueries) +
        padRight(run.releaseGatePassed ? 'PASS' : 'FAIL', colGate) +
        formatDate(run.createdAt);
      console.log(line);
    }

    console.log(separator);
    console.log(`${runs.length} run(s) displayed.`);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}

export { run as listBenchmarkRuns };
