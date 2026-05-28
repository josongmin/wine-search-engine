#!/usr/bin/env tsx
/**
 * Benchmark Trend Report
 *
 * Queries the eval_benchmark_run_trends_v view to show metric changes
 * across recent runs for each benchmark kind.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env scripts/eval/report-benchmark-trends.ts
 *   pnpm exec tsx --env-file=.env scripts/eval/report-benchmark-trends.ts --kind offline_eval
 *   pnpm exec tsx --env-file=.env scripts/eval/report-benchmark-trends.ts --metric ndcg_at_10 --last 5
 */

import 'dotenv/config';
import type { Pool as PgPool } from 'pg';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface TrendArgs {
  readonly kind?: string;
  readonly metric?: string;
  readonly last: number;
}

function parseArgs(argv: string[]): TrendArgs {
  let kind: string | undefined;
  let metric: string | undefined;
  /** Default: last 10 runs per kind×metric. */
  const DEFAULT_LAST = 10;
  let last = DEFAULT_LAST;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--kind' || a === '-k') && argv[i + 1] !== undefined) {
      kind = argv[++i];
    } else if ((a === '--metric' || a === '-m') && argv[i + 1] !== undefined) {
      metric = argv[++i];
    } else if ((a === '--last' || a === '-n') && argv[i + 1] !== undefined) {
      const parsed = parseInt(argv[++i]!, 10);
      if (Number.isFinite(parsed) && parsed > 0) last = parsed;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: report-benchmark-trends.ts [--kind <kind>] [--metric <name>] [--last <N>]');
      process.exit(0);
    }
  }

  return { kind, metric, last };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

interface TrendRow {
  readonly benchmark_kind: string;
  readonly metric_name: string;
  readonly metric_value: number;
  readonly search_snapshot_id: string | null;
  readonly corpus_hash: string;
  readonly runtime_target: string;
  readonly uses_live_api: boolean;
  readonly threshold_source: string;
  readonly gate_eligible: boolean;
  readonly comparison_compatibility_key: string;
  readonly release_gate_passed: boolean;
  readonly created_at: Date;
  readonly run_ordinal: number;
}

async function queryTrends(pool: PgPool, args: TrendArgs): Promise<TrendRow[]> {
  const conditions: string[] = ['run_ordinal <= $1'];
  const params: unknown[] = [args.last];

  if (args.kind !== undefined) {
    params.push(args.kind);
    conditions.push(`benchmark_kind = $${params.length}`);
  }
  if (args.metric !== undefined) {
    params.push(args.metric);
    conditions.push(`metric_name = $${params.length}`);
  }

  const sql = `
    SELECT benchmark_kind, metric_name, metric_value,
           search_snapshot_id, corpus_hash, runtime_target, uses_live_api,
           threshold_source, gate_eligible, comparison_compatibility_key,
           release_gate_passed, created_at, run_ordinal
    FROM eval_benchmark_run_trends_v
    WHERE ${conditions.join(' AND ')}
    ORDER BY benchmark_kind, metric_name, created_at DESC
  `;

  const result = await pool.query(sql, params);
  return result.rows as TrendRow[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTable(rows: TrendRow[]): void {
  if (rows.length === 0) {
    console.log('  No benchmark runs found.');
    return;
  }

  // Group by kind → metric
  const groups = new Map<string, TrendRow[]>();
  for (const row of rows) {
    const key = `${row.benchmark_kind}::${row.metric_name}::${row.comparison_compatibility_key}`;
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  for (const [key, groupRows] of groups) {
    const [kind, metric] = key.split('::');
    const first = groupRows[0]!;
    console.log(`\n  ${kind} / ${metric}`);
    console.log(
      `  provenance: runtime=${first.runtime_target} live=${first.uses_live_api} gate_eligible=${first.gate_eligible} corpus=${first.corpus_hash.slice(0, 12)} threshold=${first.threshold_source}`,
    );
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  ${'#'.padEnd(4)} ${'VALUE'.padEnd(12)} ${'GATE'.padEnd(6)} ${'SNAPSHOT'.padEnd(20)} ${'CREATED'}`);

    for (const row of groupRows) {
      const val = typeof row.metric_value === 'number'
        ? row.metric_value.toFixed(4)
        : String(row.metric_value);
      const gate = row.release_gate_passed ? 'PASS' : 'FAIL';
      const snap = (row.search_snapshot_id ?? '—').slice(0, 18);
      const created = row.created_at instanceof Date
        ? row.created_at.toISOString().slice(0, 19)
        : String(row.created_at).slice(0, 19);

      console.log(`  ${String(row.run_ordinal).padEnd(4)} ${val.padEnd(12)} ${gate.padEnd(6)} ${snap.padEnd(20)} ${created}`);
    }

    // Delta between newest and oldest in group
    if (groupRows.length >= 2) {
      const newest = groupRows[0]!.metric_value;
      const oldest = groupRows[groupRows.length - 1]!.metric_value;
      const delta = newest - oldest;
      const pct = oldest !== 0 ? ((delta / Math.abs(oldest)) * 100).toFixed(1) : 'N/A';
      const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
      console.log(`  ${arrow} Δ = ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} (${pct}%) over ${groupRows.length} runs`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let pool: PgPool;
  try {
    const pg = await import('pg');
    const dbUrl = process.env['DATABASE_URL'];
    pool = dbUrl !== undefined
      ? new pg.default.Pool({ connectionString: dbUrl })
      : new pg.default.Pool({
          host: process.env['PG_HOST'] ?? 'localhost',
          port: parseInt(process.env['PG_PORT'] ?? '5432', 10),
          database: process.env['PG_DATABASE'] ?? 'wine_search',
          user: process.env['PG_USER'],
          password: process.env['PG_PASSWORD'],
        });
  } catch (err) {
    console.error('Failed to connect to database:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  try {
    console.log('\n  Benchmark Trend Report');
    console.log(`  Filters: kind=${args.kind ?? 'all'}, metric=${args.metric ?? 'all'}, last=${args.last}`);

    const rows = await queryTrends(pool, args);
    formatTable(rows);
    console.log('');
  } finally {
    await pool.end();
  }
}

void main().catch((err: unknown) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
