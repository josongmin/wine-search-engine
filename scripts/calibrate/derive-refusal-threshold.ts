#!/usr/bin/env tsx
/**
 * P0.2 — AURC-derived per-class refusal threshold (CLI entrypoint).
 *
 * Reads recent `(score, isCorrect, queryClass)` tuples from `eval_results`,
 * derives the per-class threshold τ via the SOTA selective-prediction
 * algorithm (Geifman & El-Yaniv 2017), and persists the result into the
 * `refusal_thresholds` table created by migration 021.
 *
 * Usage:
 *   pnpm tsx scripts/calibrate/derive-refusal-threshold.ts \
 *       [--target-coverage 0.85] \
 *       [--since 2026-01-01T00:00:00Z] \
 *       [--report-dir data/refusal-threshold-reports]
 *
 * Environment overrides:
 *   REFUSAL_DERIVE_TARGET_COVERAGE       — operating coverage (default 0.85)
 *   REFUSAL_DERIVE_MIN_SAMPLES_PER_CLASS — abort if any class has fewer
 *                                          samples than this (default 200)
 *
 * Outputs:
 *   - Idempotent UPSERT into `refusal_thresholds` keyed by query_class
 *   - JSON diagnostic report at `<report-dir>/<UTC-ISO timestamp>.json`
 *   - Non-zero exit code if any class fails the minimum-samples gate
 *
 * Hard guarantees (per CLAUDE.md):
 *   - All numeric inputs go through `Number.isFinite` guards
 *   - No magic numbers — every threshold is a named module-scope const
 *   - No `||` defaulting on numeric env vars; only `??`
 *   - DB writes happen inside a single transaction so a partial fit is
 *     never observable to the runtime policy
 */

import 'dotenv/config';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import {
  deriveRefusalThresholds,
  type RefusalDerivationSample,
} from '../../src/domain/calibration/service/refusal-threshold-derivation.js';

// ────────────────────────────────────────────────────────────────────────────
// Named constants (no magic numbers per CLAUDE.md §15)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Default operating point on the AURC curve. 0.85 leaves 15% of the lowest-
 * confidence predictions to be refused on average — a coverage band wide
 * enough to drive a measurable hallucination drop without collapsing recall.
 * Operators MAY override via --target-coverage or REFUSAL_DERIVE_TARGET_COVERAGE.
 */
const TARGET_COVERAGE_DEFAULT = 0.85;

/**
 * Minimum sample size per class. With 200 samples, the binomial Wilson 95% CI
 * half-width at p=0.05 is ≈ 3% — small enough that the AURC operating point is
 * not dominated by sampling noise. Below this bound the derived τ is more
 * statistical artifact than a calibration estimate, so we refuse to persist.
 */
const MIN_SAMPLES_FOR_THRESHOLD = 200;

/** Default directory for diagnostic reports. */
const DEFAULT_REPORT_DIR = 'data/refusal-threshold-reports';

/**
 * Reserved query-class key used as the cross-class fallback by the runtime
 * policy. The derivation must include a `general` row (synthesised from the
 * full sample population) so that `RefusalThresholdProvider` consumers can
 * resolve unknown classes deterministically.
 */
const FALLBACK_CLASS_KEY = 'general';

// ────────────────────────────────────────────────────────────────────────────
// CLI argument parsing
// ────────────────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly targetCoverage: number;
  readonly since?: Date;
  readonly reportDir: string;
  readonly minSamplesPerClass: number;
  /** When true, derive but do not write to PG. Useful for sanity checks. */
  readonly dryRun: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let targetCoverage: number = TARGET_COVERAGE_DEFAULT;
  let since: Date | undefined;
  let reportDir = DEFAULT_REPORT_DIR;
  let minSamples = MIN_SAMPLES_FOR_THRESHOLD;
  let dryRun = false;

  const envCoverage = process.env['REFUSAL_DERIVE_TARGET_COVERAGE'];
  if (envCoverage !== undefined && envCoverage.length > 0) {
    const parsed = Number(envCoverage);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
      throw new Error(
        `REFUSAL_DERIVE_TARGET_COVERAGE must be a finite number in (0,1]; got ${envCoverage}`,
      );
    }
    targetCoverage = parsed;
  }

  const envMinSamples = process.env['REFUSAL_DERIVE_MIN_SAMPLES_PER_CLASS'];
  if (envMinSamples !== undefined && envMinSamples.length > 0) {
    const parsed = Number(envMinSamples);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(
        `REFUSAL_DERIVE_MIN_SAMPLES_PER_CLASS must be a positive finite integer; got ${envMinSamples}`,
      );
    }
    minSamples = Math.floor(parsed);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target-coverage') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--target-coverage requires a value');
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
        throw new Error(`--target-coverage must be in (0,1]; got ${next}`);
      }
      targetCoverage = parsed;
      i++;
    } else if (arg === '--since') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--since requires an ISO timestamp');
      const parsed = new Date(next);
      if (!Number.isFinite(parsed.getTime())) {
        throw new Error(`--since must be a valid ISO timestamp; got ${next}`);
      }
      since = parsed;
      i++;
    } else if (arg === '--report-dir') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--report-dir requires a value');
      reportDir = next;
      i++;
    } else if (arg === '--min-samples-per-class') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('--min-samples-per-class requires a value');
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`--min-samples-per-class must be a positive integer; got ${next}`);
      }
      minSamples = Math.floor(parsed);
      i++;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg !== undefined && arg.length > 0) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return {
    targetCoverage,
    ...(since !== undefined ? { since } : {}),
    reportDir,
    minSamplesPerClass: minSamples,
    dryRun,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: derive-refusal-threshold.ts [options]',
      '',
      'Options:',
      '  --target-coverage <0..1>          Operating point on the AURC curve (default 0.85)',
      '  --since <ISO timestamp>           Only include eval_results created on/after this date',
      '  --report-dir <path>               Directory for JSON diagnostic reports',
      '  --min-samples-per-class <int>     Minimum sample size per class (default 200)',
      '  --dry-run                         Compute and report but do not write to PG',
      '  --help, -h                        Print this help message',
      '',
    ].join('\n'),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Sample sourcing
// ────────────────────────────────────────────────────────────────────────────

interface EvalRow {
  readonly case_id: string;
  readonly query_class: string;
  readonly predicted_status: string;
  readonly decision_confidence: number;
  readonly is_correct_resolve: boolean;
}

async function loadSamples(
  pool: Pool,
  since: Date | undefined,
): Promise<readonly RefusalDerivationSample[]> {
  const params: unknown[] = [];
  let whereClause = '';
  if (since !== undefined) {
    params.push(since);
    whereClause = `WHERE er.created_at >= $${params.length}`;
  }
  const result = await pool.query<EvalRow>(
    `SELECT
       ec.case_id AS case_id,
       ec.query_class AS query_class,
       er.predicted_status AS predicted_status,
       er.decision_confidence AS decision_confidence,
       er.is_correct_resolve AS is_correct_resolve
     FROM eval_results er
     JOIN eval_cases ec ON ec.case_id = er.case_id
     ${whereClause}
     ORDER BY er.created_at ASC`,
    params,
  );

  const out: RefusalDerivationSample[] = [];
  for (const row of result.rows) {
    if (typeof row.decision_confidence !== 'number') continue;
    if (!Number.isFinite(row.decision_confidence)) continue;
    if (typeof row.query_class !== 'string' || row.query_class.length === 0) continue;
    out.push({
      score: row.decision_confidence,
      isCorrect: row.is_correct_resolve === true,
      queryClass: row.query_class,
    });
  }
  return out;
}

function buildDatasetHash(samples: readonly RefusalDerivationSample[]): string {
  const hasher = createHash('sha256');
  // Stable ordering: sort by (queryClass, score, isCorrect) before hashing.
  const sorted = [...samples].sort((a, b) => {
    if (a.queryClass !== b.queryClass) return a.queryClass.localeCompare(b.queryClass);
    if (a.score !== b.score) return a.score - b.score;
    return Number(a.isCorrect) - Number(b.isCorrect);
  });
  for (const s of sorted) {
    hasher.update(`${s.queryClass}${s.score.toString()}${s.isCorrect ? '1' : '0'}\n`);
  }
  return hasher.digest('hex');
}

// ────────────────────────────────────────────────────────────────────────────
// Persistence
// ────────────────────────────────────────────────────────────────────────────

interface PersistableThreshold {
  readonly queryClass: string;
  readonly threshold: number;
  readonly targetCoverage: number;
  readonly riskAtCoverage: number;
  readonly sampleSize: number;
  readonly aurc: number;
  readonly fittedAt: Date;
  readonly datasetHash: string;
}

async function persistThresholds(
  pool: Pool,
  rows: readonly PersistableThreshold[],
): Promise<void> {
  if (rows.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      await client.query(
        `INSERT INTO refusal_thresholds (
           query_class, threshold, target_coverage, risk_at_coverage,
           sample_size, aurc, fitted_at, dataset_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (query_class) DO UPDATE SET
           threshold        = EXCLUDED.threshold,
           target_coverage  = EXCLUDED.target_coverage,
           risk_at_coverage = EXCLUDED.risk_at_coverage,
           sample_size      = EXCLUDED.sample_size,
           aurc             = EXCLUDED.aurc,
           fitted_at        = EXCLUDED.fitted_at,
           dataset_hash     = EXCLUDED.dataset_hash`,
        [
          row.queryClass,
          row.threshold,
          row.targetCoverage,
          row.riskAtCoverage,
          row.sampleSize,
          row.aurc,
          row.fittedAt,
          row.datasetHash,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Report writing
// ────────────────────────────────────────────────────────────────────────────

interface DiagnosticReport {
  readonly fittedAt: string;
  readonly targetCoverage: number;
  readonly minSamplesPerClass: number;
  readonly datasetHash: string;
  readonly totalSamples: number;
  readonly thresholds: readonly PersistableThreshold[];
  readonly skipped: readonly { readonly queryClass: string; readonly sampleSize: number }[];
  readonly dryRun: boolean;
}

async function writeReport(reportDir: string, report: DiagnosticReport): Promise<string> {
  await fs.mkdir(reportDir, { recursive: true });
  const stamp = report.fittedAt.replace(/[:.]/g, '-');
  const filePath = path.join(reportDir, `${stamp}.json`);
  await fs.writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
  return filePath;
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

export async function runDerive(args: CliArgs, pool: Pool): Promise<DiagnosticReport> {
  const samples = await loadSamples(pool, args.since);
  if (samples.length === 0) {
    throw new Error(
      'No eval_results rows found. Run an offline eval before deriving refusal thresholds.',
    );
  }

  // Inject a synthetic `general` class that is the union of all classes so the
  // runtime always has a fallback row. The fallback shares the same AURC
  // derivation so its threshold is comparable to per-class values.
  const samplesWithFallback: RefusalDerivationSample[] = [
    ...samples,
    ...samples.map((s) => ({
      score: s.score,
      isCorrect: s.isCorrect,
      queryClass: FALLBACK_CLASS_KEY,
    })),
  ];

  const { fitted, skipped } = deriveRefusalThresholds(samplesWithFallback, {
    targetCoverage: args.targetCoverage,
    minSamplesPerClass: args.minSamplesPerClass,
  });

  // Guardrails: at least the fallback row must succeed. Any class below the
  // minimum-samples bound aborts the derive so the operator is forced to
  // collect more eval data instead of silently shipping a fragile τ.
  if (skipped.length > 0) {
    const list = skipped
      .map((s) => `${s.queryClass} (n=${s.sampleSize})`)
      .join(', ');
    throw new Error(
      `Refusing to persist refusal thresholds: ${skipped.length} class(es) below the ${args.minSamplesPerClass}-sample minimum: ${list}`,
    );
  }
  if (fitted.length === 0) {
    throw new Error('Derivation produced no thresholds — refusing to persist an empty table.');
  }

  const datasetHash = buildDatasetHash(samples);
  const fittedAt = new Date();
  const rows: PersistableThreshold[] = fitted.map((r) => ({
    queryClass: r.queryClass,
    threshold: r.threshold,
    targetCoverage: r.targetCoverage,
    riskAtCoverage: r.riskAtCoverage,
    sampleSize: r.sampleSize,
    aurc: r.aurc,
    fittedAt,
    datasetHash,
  }));

  if (!args.dryRun) {
    await persistThresholds(pool, rows);
  }

  return {
    fittedAt: fittedAt.toISOString(),
    targetCoverage: args.targetCoverage,
    minSamplesPerClass: args.minSamplesPerClass,
    datasetHash,
    totalSamples: samples.length,
    thresholds: rows,
    skipped,
    dryRun: args.dryRun,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const connectionString = process.env['PG_CONNECTION_STRING'] ?? process.env['DATABASE_URL'];
  const pool = connectionString !== undefined && connectionString.length > 0
    ? new Pool({ connectionString })
    : new Pool({
        host: process.env['PG_HOST'] ?? 'localhost',
        port: Number(process.env['PG_PORT'] ?? '5432'),
        database: process.env['PG_DATABASE'] ?? 'wine',
        user: process.env['PG_USER'] ?? 'wine',
        password: process.env['PG_PASSWORD'] ?? '',
      });

  try {
    const report = await runDerive(args, pool);
    const reportPath = await writeReport(args.reportDir, report);
    process.stdout.write(`Wrote diagnostic report to ${reportPath}\n`);
    process.stdout.write(
      `Persisted ${report.thresholds.length} threshold(s); skipped ${report.skipped.length}.\n`,
    );
  } finally {
    await pool.end();
  }
}

// Only run when invoked directly; importing for tests must not trigger main().
const isDirectInvocation =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('derive-refusal-threshold.ts');

if (isDirectInvocation) {
  main().catch((err) => {
    process.stderr.write(`[derive-refusal-threshold] error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export {
  TARGET_COVERAGE_DEFAULT,
  MIN_SAMPLES_FOR_THRESHOLD,
  FALLBACK_CLASS_KEY,
  parseArgs,
  buildDatasetHash,
};
export type { CliArgs, DiagnosticReport, PersistableThreshold };
