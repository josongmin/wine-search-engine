#!/usr/bin/env tsx
/**
 * Extract calibration trace (P0.1: Nightly calibration auto-pipeline).
 *
 * Reads recent `eval_results` rows joined with `eval_cases` (for `query_class`)
 * and emits NDJSON of `{score, isCorrect, queryType?}` consumed by
 * `scripts/calibrate/fit-resolver-calibration.ts`.
 *
 * Idempotency: the script does not write back to PG. It produces a deterministic
 * stream for a fixed `--since` window so re-runs against the same DB state
 * produce the same trace (modulo row insertion order — sorted by created_at).
 *
 * Usage:
 *   tsx scripts/eval/extract-calibration-trace.ts \
 *     --output data/calibration/trace-$(date -u +%Y%m%d).ndjson \
 *     [--since 7]                 # window in days; default = 7
 *     [--min-samples 100]         # refuse to emit below this count
 *
 * Exit codes:
 *   0  trace successfully written
 *   1  insufficient samples / DB error / IO error
 *   2  CLI usage error
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import { isQueryClass } from '../../src/domain/shared/types/query-class.js';
import type { QueryClass } from '../../src/domain/shared/types/index.js';

// ────────────────────────────────────────────────────────────────
// Constants (CLAUDE.md rule 15 — no magic numbers in production paths;
// scripts/ has the rule relaxed, but the values still earn names because
// they drive operator-facing behaviour.)
// ────────────────────────────────────────────────────────────────

/** Default look-back window. 7 days balances "enough samples" against
 *  drift staleness (RFC-016 calibration ages after ~2 weeks per ECE-drift
 *  studies). Can be widened via --since when traffic is low. */
const DEFAULT_SINCE_DAYS = 7;
/** Minimum sample size for emitting a trace. Below this Platt fitting
 *  is unreliable (high-variance sigmoid fit) and the trainer would
 *  silently produce a useless model. Matches MIN_RELIABLE_SAMPLE_SIZE
 *  in scripts/eval/calibration-report.ts. */
const DEFAULT_MIN_SAMPLES = 100;
/** ms in one day, used for the --since arithmetic. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Process exit code for usage errors (CLI parsing). */
const EXIT_USAGE = 2;
/** Process exit code for runtime failures (DB, IO, insufficient data). */
const EXIT_RUNTIME = 1;

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface CalibrationTraceRow {
  /** Raw (pre-calibration) top-1 resolver score, in the calibrator's input range. */
  readonly score: number;
  /** Realised label: did the resolver pick the expected entity? */
  readonly isCorrect: boolean;
  /** Stratification label — query class. */
  readonly queryType?: QueryClass;
}

export interface ExtractCliArgs {
  readonly output: string;
  readonly sinceDays: number;
  readonly minSamples: number;
}

interface EvalResultJoinedRow {
  readonly top1_raw_score: number | null;
  readonly is_correct_resolve: boolean;
  readonly query_class: string;
  readonly created_at: Date;
}

// ────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────

const HELP_TEXT = `Extract calibration trace

Usage:
  tsx scripts/eval/extract-calibration-trace.ts --output <file.ndjson> [--since N] [--min-samples M]

Options:
  --output, -o        Path to write NDJSON trace (required).
  --since N           Look-back window in days. Default ${String(DEFAULT_SINCE_DAYS)}.
  --min-samples M     Refuse to emit if fewer than M usable rows. Default ${String(DEFAULT_MIN_SAMPLES)}.
  --help, -h          Show this help.
`;

export function parseExtractArgs(argv: readonly string[]): ExtractCliArgs | { help: true } {
  let output = '';
  let sinceDays: number = DEFAULT_SINCE_DAYS;
  let minSamples: number = DEFAULT_MIN_SAMPLES;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    } else if (arg === '--output' || arg === '-o') {
      output = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--since') {
      const raw = argv[i + 1] ?? '';
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--since must be a positive number of days, got "${raw}"`);
      }
      sinceDays = parsed;
      i += 1;
    } else if (arg === '--min-samples') {
      const raw = argv[i + 1] ?? '';
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--min-samples must be a positive integer, got "${raw}"`);
      }
      minSamples = parsed;
      i += 1;
    }
  }

  if (output === '') {
    throw new Error('--output is required');
  }

  return { output, sinceDays, minSamples };
}

// ────────────────────────────────────────────────────────────────
// Pure row → trace conversion (unit-testable without PG)
// ────────────────────────────────────────────────────────────────

/**
 * Convert a batch of joined eval_results rows into calibration trace rows.
 *
 * Rows are skipped when:
 *   - top1_raw_score is NULL (legacy or absent raw score)
 *   - top1_raw_score is not finite (corrupted ETL write)
 *   - query_class is not a known {@link QueryClass} (silently drop unknown
 *     stratification labels rather than poison the fitter; the per-class
 *     fitter only cares about labels it can map back).
 *
 * Deterministic ordering: input order is preserved. Callers should query
 * `ORDER BY created_at ASC` so re-runs against the same DB state produce
 * the same NDJSON byte stream.
 */
export function rowsToTrace(
  rows: readonly EvalResultJoinedRow[],
): readonly CalibrationTraceRow[] {
  const out: CalibrationTraceRow[] = [];
  for (const row of rows) {
    const rawScore = row.top1_raw_score;
    if (rawScore == null) continue;
    if (!Number.isFinite(rawScore)) continue;
    const queryType = isQueryClass(row.query_class) ? row.query_class : undefined;
    out.push({
      score: rawScore,
      isCorrect: row.is_correct_resolve,
      ...(queryType !== undefined ? { queryType } : {}),
    });
  }
  return out;
}

/**
 * Serialise trace rows to NDJSON. Each line ends with `\n`. Numeric and
 * boolean values are emitted via `JSON.stringify` for deterministic output.
 */
export function serialiseTraceToNdjson(rows: readonly CalibrationTraceRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(JSON.stringify(row));
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

// ────────────────────────────────────────────────────────────────
// PG layer
// ────────────────────────────────────────────────────────────────

function createPool(): Pool {
  const connectionString = process.env['DATABASE_URL'];
  if (connectionString !== undefined && connectionString.length > 0) {
    return new Pool({ connectionString });
  }
  const port = Number.parseInt(process.env['PG_PORT'] ?? process.env['PGPORT'] ?? '5432', 10);
  return new Pool({
    host: process.env['PG_HOST'] ?? process.env['PGHOST'] ?? 'localhost',
    port,
    database: process.env['PG_DATABASE'] ?? process.env['PGDATABASE'] ?? 'wine_search',
    user: process.env['PG_USER'] ?? process.env['PGUSER'] ?? 'postgres',
    password: process.env['PG_PASSWORD'] ?? process.env['PGPASSWORD'] ?? '',
  });
}

async function fetchRows(
  pool: Pool,
  sinceDays: number,
): Promise<readonly EvalResultJoinedRow[]> {
  const sinceMs = Date.now() - sinceDays * MS_PER_DAY;
  const sinceDate = new Date(sinceMs);
  const result = await pool.query<EvalResultJoinedRow>(
    `SELECT er.top1_raw_score,
            er.is_correct_resolve,
            ec.query_class,
            er.created_at
       FROM eval_results er
       JOIN eval_cases   ec ON ec.case_id = er.case_id
      WHERE er.created_at >= $1
        AND er.top1_raw_score IS NOT NULL
      ORDER BY er.created_at ASC`,
    [sinceDate],
  );
  return result.rows;
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: ExtractCliArgs;
  try {
    const parsed = parseExtractArgs(process.argv.slice(2));
    if ('help' in parsed) {
      process.stdout.write(HELP_TEXT);
      return;
    }
    args = parsed;
  } catch (err) {
    process.stderr.write(`[extract-calibration-trace] error: ${(err as Error).message}\n\n${HELP_TEXT}`);
    process.exit(EXIT_USAGE);
    return;
  }

  const pool = createPool();
  let rows: readonly EvalResultJoinedRow[];
  try {
    rows = await fetchRows(pool, args.sinceDays);
  } catch (err) {
    process.stderr.write(`[extract-calibration-trace] DB query failed: ${(err as Error).message}\n`);
    await pool.end();
    process.exit(EXIT_RUNTIME);
    return;
  }
  await pool.end();

  const trace = rowsToTrace(rows);
  if (trace.length < args.minSamples) {
    process.stderr.write(
      `[extract-calibration-trace] insufficient samples: got ${String(trace.length)}, need ${String(args.minSamples)} ` +
        `(window=${String(args.sinceDays)}d). Refusing to emit — no heuristic fallback.\n`,
    );
    process.exit(EXIT_RUNTIME);
    return;
  }

  const outputPath = resolve(process.cwd(), args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialiseTraceToNdjson(trace), 'utf8');
  process.stderr.write(
    `[extract-calibration-trace] wrote ${String(trace.length)} rows to ${outputPath} (window=${String(args.sinceDays)}d).\n`,
  );
}

const isMain = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const url = new URL(`file://${resolve(entry)}`).href;
    return import.meta.url === url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`[extract-calibration-trace] fatal: ${(err as Error).message}\n`);
    process.exit(EXIT_RUNTIME);
  });
}
