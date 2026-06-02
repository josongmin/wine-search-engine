#!/usr/bin/env tsx
/**
 * Fit resolver calibration (P0.1: Nightly calibration auto-pipeline).
 *
 * Reads a calibration trace (NDJSON of `{score, isCorrect, queryType?}`
 * emitted by `scripts/eval/extract-calibration-trace.ts`), fits Platt /
 * Isotonic / Temperature scaling via the SOTA++ calibration suite
 * (`src/domain/calibration/service/calibration-suite.ts`), persists the
 * winning method per query class into `calibration_params` with a fresh
 * `fitted_at`, and writes a diagnostic report (ECE before/after, AURC,
 * sample size, dataset hash) to `data/calibration-reports/<timestamp>.json`.
 *
 * SOTA++ baseline: no heuristic fallback. If the trace is too small or
 * lacks both positive and negative examples, the script throws — the
 * AdmissionGate trust window will then expire naturally rather than
 * pretend a degenerate model is valid.
 *
 * Usage:
 *   tsx scripts/calibrate/fit-resolver-calibration.ts \
 *     --input data/calibration/trace-YYYYMMDD.ndjson \
 *     [--report-dir data/calibration-reports] \
 *     [--min-samples 100] \
 *     [--holdout-ratio 0.2] \
 *     [--seed 42]
 *
 * Exit codes:
 *   0 success
 *   1 runtime error (fit failed, persist failed, IO error)
 *   2 CLI usage error
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import process from 'node:process';
import { Pool } from 'pg';
import { z } from 'zod';

import { createScriptPgPool } from '../lib/script-pg-pool.js';
import { PgCalibrationStore } from '../../src/infrastructure/adapter/pg-calibration-store.js';
import { buildCalibrationReport } from '../../src/domain/calibration/service/calibration-suite.js';
import { computeECE } from '../../src/domain/calibration/service/ece.js';
import { isQueryClass } from '../../src/domain/shared/types/query-class.js';
import type { QueryClass } from '../../src/domain/shared/types/index.js';
import type { CalibrationParams } from '../../src/domain/resolver/port/calibration-store.port.js';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

/** Default minimum trace size below which fitting refuses to proceed.
 *  Below this Platt fitting is dominated by variance (sigmoid params
 *  oscillate) and the resulting ECE is unreliable. */
const DEFAULT_MIN_SAMPLES = 100;
/** Default fraction of the trace held out for ECE evaluation after fit.
 *  20% matches the offline-eval baseline and gives a reasonable variance
 *  estimate while preserving 80% for fitting. */
const DEFAULT_HOLDOUT_RATIO = 0.2;
/** Deterministic seed for the stratified split. Identical inputs produce
 *  identical splits across runs — required for reproducible reports. */
const DEFAULT_SEED = 42;
/** Default directory to write diagnostic reports. */
const DEFAULT_REPORT_DIR = 'data/calibration-reports';
/** Process exit codes. */
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 1;
/** Minimum positives/negatives needed in a per-class subset before fitting.
 *  Below 5 of either class the fitter degenerates to a constant 0.5 — Platt
 *  cannot recover sigmoid params from a single-class subset. */
const PER_CLASS_MIN_PER_LABEL = 5;
/** Lower bound (inclusive) and upper bound (inclusive) for holdout ratio. */
const HOLDOUT_RATIO_MIN = 0.05;
const HOLDOUT_RATIO_MAX = 0.5;
/** Time precision for the report filename (UTC). */
const REPORT_TIMESTAMP_REGEX = /[:.]/gu;

// ────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────

const HELP_TEXT = `Fit resolver calibration

Usage:
  tsx scripts/calibrate/fit-resolver-calibration.ts \\
      --input <trace.ndjson> [--report-dir <dir>] \\
      [--min-samples N] [--holdout-ratio R] [--seed S] [--dry-run]

Options:
  --input, -i        Path to NDJSON trace from extract-calibration-trace.ts (required).
  --report-dir       Directory for diagnostic report JSON. Default ${DEFAULT_REPORT_DIR}.
  --min-samples      Minimum samples required to fit. Default ${String(DEFAULT_MIN_SAMPLES)}.
  --holdout-ratio    Fraction held out for after-fit ECE. Default ${String(DEFAULT_HOLDOUT_RATIO)}.
  --seed             RNG seed for the stratified split. Default ${String(DEFAULT_SEED)}.
  --dry-run          Print the report without writing PG or the report file.
  --help, -h         Show this help.
`;

interface FitCliArgs {
  readonly input: string;
  readonly reportDir: string;
  readonly minSamples: number;
  readonly holdoutRatio: number;
  readonly seed: number;
  readonly dryRun: boolean;
}

export function parseFitArgs(argv: readonly string[]): FitCliArgs | { help: true } {
  let input = '';
  let reportDir = DEFAULT_REPORT_DIR;
  let minSamples = DEFAULT_MIN_SAMPLES;
  let holdoutRatio = DEFAULT_HOLDOUT_RATIO;
  let seed = DEFAULT_SEED;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--input' || arg === '-i') {
      input = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--report-dir') {
      reportDir = argv[i + 1] ?? DEFAULT_REPORT_DIR;
      i += 1;
    } else if (arg === '--min-samples') {
      const parsed = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--min-samples must be a positive integer, got "${argv[i + 1] ?? ''}"`);
      }
      minSamples = parsed;
      i += 1;
    } else if (arg === '--holdout-ratio') {
      const parsed = Number.parseFloat(argv[i + 1] ?? '');
      if (!Number.isFinite(parsed) || parsed < HOLDOUT_RATIO_MIN || parsed > HOLDOUT_RATIO_MAX) {
        throw new Error(
          `--holdout-ratio must be in [${String(HOLDOUT_RATIO_MIN)}, ${String(HOLDOUT_RATIO_MAX)}], got "${argv[i + 1] ?? ''}"`,
        );
      }
      holdoutRatio = parsed;
      i += 1;
    } else if (arg === '--seed') {
      const parsed = Number.parseInt(argv[i + 1] ?? '', 10);
      if (!Number.isFinite(parsed)) {
        throw new Error(`--seed must be an integer, got "${argv[i + 1] ?? ''}"`);
      }
      seed = parsed;
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    }
  }

  if (input === '') {
    throw new Error('--input is required');
  }
  return { input, reportDir, minSamples, holdoutRatio, seed, dryRun };
}

// ────────────────────────────────────────────────────────────────
// Trace loading + validation
// ────────────────────────────────────────────────────────────────

const TraceRowSchema = z
  .object({
    score: z.number().finite(),
    isCorrect: z.boolean(),
    queryType: z.string().optional(),
  })
  .strict();

export interface TraceRow {
  readonly score: number;
  readonly isCorrect: boolean;
  readonly queryType?: QueryClass;
}

export function parseTraceNdjson(content: string): readonly TraceRow[] {
  const lines = content.split(/\r?\n/);
  const out: TraceRow[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim() ?? '';
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      process.stderr.write(
        `[fit-calibration] skipping line ${String(i + 1)}: invalid JSON (${(err as Error).message})\n`,
      );
      continue;
    }
    const validated = TraceRowSchema.safeParse(parsed);
    if (!validated.success) {
      process.stderr.write(
        `[fit-calibration] skipping line ${String(i + 1)}: schema mismatch\n`,
      );
      continue;
    }
    const queryType =
      validated.data.queryType !== undefined && isQueryClass(validated.data.queryType)
        ? validated.data.queryType
        : undefined;
    out.push({
      score: validated.data.score,
      isCorrect: validated.data.isCorrect,
      ...(queryType !== undefined ? { queryType } : {}),
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// Deterministic PRNG (xorshift32) for the stratified split
// ────────────────────────────────────────────────────────────────

/** Bit width of xorshift32 register — used by the shift constants below. */
const XORSHIFT_SHIFT_A = 13;
const XORSHIFT_SHIFT_B = 17;
const XORSHIFT_SHIFT_C = 5;
const XORSHIFT_DIVISOR = 0x1_0000_0000;

function makeRng(seed: number): () => number {
  let state = (seed | 0) || 1;
  return () => {
    state ^= state << XORSHIFT_SHIFT_A;
    state ^= state >>> XORSHIFT_SHIFT_B;
    state ^= state << XORSHIFT_SHIFT_C;
    // Map to [0, 1) by dividing by 2^32.
    return ((state >>> 0) % XORSHIFT_DIVISOR) / XORSHIFT_DIVISOR;
  };
}

/** Fisher–Yates shuffle with a seeded RNG. Returns a shuffled COPY. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j]!;
    out[j] = tmp!;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// Stratified holdout
// ────────────────────────────────────────────────────────────────

export interface StratifiedSplit {
  readonly train: readonly TraceRow[];
  readonly holdout: readonly TraceRow[];
}

/**
 * Stratified split by the binary `isCorrect` label.
 *
 * Why stratify by label rather than `queryType`: the calibrator's input
 * (raw score → correctness probability) is the unit being fit. Holdout
 * imbalance on `isCorrect` would skew the ECE estimate; stratifying by
 * label keeps the positive/negative ratio identical across train and
 * holdout, which is the requirement for ECE-monotonic generalisation.
 *
 * Throws when either label class is too small to support fitting after
 * the split — refusing to silently produce a constant-0.5 model.
 */
export function stratifiedHoldoutSplit(
  rows: readonly TraceRow[],
  holdoutRatio: number,
  seed: number,
): StratifiedSplit {
  const positives = rows.filter((r) => r.isCorrect);
  const negatives = rows.filter((r) => !r.isCorrect);

  if (positives.length < PER_CLASS_MIN_PER_LABEL || negatives.length < PER_CLASS_MIN_PER_LABEL) {
    throw new Error(
      `Cannot fit calibration: insufficient class balance — positives=${String(positives.length)}, ` +
        `negatives=${String(negatives.length)}. Need >=${String(PER_CLASS_MIN_PER_LABEL)} of each.`,
    );
  }

  const rng = makeRng(seed);
  const shuffledPos = shuffle(positives, rng);
  const shuffledNeg = shuffle(negatives, rng);
  const posHoldoutN = Math.max(1, Math.floor(shuffledPos.length * holdoutRatio));
  const negHoldoutN = Math.max(1, Math.floor(shuffledNeg.length * holdoutRatio));

  const holdout = [
    ...shuffledPos.slice(0, posHoldoutN),
    ...shuffledNeg.slice(0, negHoldoutN),
  ];
  const train = [
    ...shuffledPos.slice(posHoldoutN),
    ...shuffledNeg.slice(negHoldoutN),
  ];
  return { train, holdout };
}

// ────────────────────────────────────────────────────────────────
// Fitting + winner selection
// ────────────────────────────────────────────────────────────────

interface ClassFitOutcome {
  readonly queryClass: QueryClass;
  readonly method: CalibrationParams['method'];
  readonly params: Record<string, number>;
  readonly eceBefore: number;
  readonly eceAfter: number;
  readonly aurc: number;
  readonly sampleSize: number;
}

interface AggregateReport {
  readonly fittedAt: string;
  readonly datasetHash: string;
  readonly totalSamples: number;
  readonly classFits: readonly ClassFitOutcome[];
  readonly skippedClasses: readonly { readonly queryClass: string; readonly reason: string }[];
}

/**
 * Apply each fitted method to the holdout, pick the one with the lowest
 * ECE-after. The calibration-suite produces Platt / temperature / conformal
 * estimates and an optimal threshold; for persisted CalibrationParams the
 * resolver supports `platt`, `isotonic`, and `temperature`. Conformal is
 * informational only (no persisted method).
 *
 * SOTA++ rationale: the lowest holdout-ECE method wins, not the lowest
 * training-ECE method. Picking by training ECE would over-fit Platt's
 * sigmoid to the trace and silently inflate the deployed calibration error.
 */
function pickWinningMethodOnHoldout(
  train: readonly TraceRow[],
  holdout: readonly TraceRow[],
): { method: CalibrationParams['method']; params: Record<string, number>; eceAfter: number } {
  if (train.length === 0 || holdout.length === 0) {
    throw new Error('pickWinningMethodOnHoldout: empty train or holdout set');
  }

  const trainSuite = buildCalibrationReport(
    train.map((r) => ({ score: r.score, correct: r.isCorrect })),
  );

  // Candidate 1: Platt sigmoid
  const plattA = trainSuite.platt.a;
  const plattB = trainSuite.platt.b;
  const plattHoldoutEce = computeECE(
    holdout.map((r) => ({
      confidence: trainSuite.platt.calibrate(r.score),
      correct: r.isCorrect,
    })),
  ).ece;

  // Candidate 2: Temperature scaling. We re-derive a temperature by
  // searching for the value that minimises holdout NLL via a coarse grid
  // — but since the calibration-suite doesn't expose temperature fitting,
  // we approximate temperature=1/(2*|a|) (matches the Platt slope's
  // implicit "effective temperature"). This is SOTA-bounded — a proper
  // L-BFGS temperature fit is RFC future work.
  //
  // Note: the resolver's temperature path is sigmoid-shaped (no softmax),
  // so the Platt sigmoid IS the temperature sigmoid when b=0. Skip if b!=0.
  const tempCandidate: { ece: number; params: Record<string, number> } | null = (() => {
    if (Math.abs(plattB) > 0.5) {
      // bias-shifted Platt isn't representable as pure temperature
      return null;
    }
    const T = 1 / Math.max(Math.abs(plattA), 0.05);
    const ece = computeECE(
      holdout.map((r) => ({
        confidence: 1 / (1 + Math.exp(-r.score / T)),
        correct: r.isCorrect,
      })),
    ).ece;
    return { ece, params: { temperature: T } };
  })();

  // Candidate 3: Isotonic — encode as a sorted breakpoint table. We
  // discretise the train set into 10 quantile bins and emit (x_i, y_i)
  // pairs of (mean confidence, mean correctness). The resolver's
  // applyIsotonicFallback() handles the lookup with linear interpolation.
  const isotonicEncoding = encodeIsotonicBreakpoints(train);
  const isotonicHoldoutEce = computeECE(
    holdout.map((r) => ({
      confidence: evaluateIsotonicBreakpoints(isotonicEncoding, r.score),
      correct: r.isCorrect,
    })),
  ).ece;

  const candidates: { method: CalibrationParams['method']; params: Record<string, number>; ece: number }[] = [
    { method: 'platt', params: { a: plattA, b: plattB }, ece: plattHoldoutEce },
    { method: 'isotonic', params: isotonicEncoding, ece: isotonicHoldoutEce },
  ];
  if (tempCandidate !== null) {
    candidates.push({ method: 'temperature', params: tempCandidate.params, ece: tempCandidate.ece });
  }

  // Pick lowest-ECE; tie-break is method order above (platt → isotonic → temperature)
  // for determinism. CLAUDE.md bugbash rule on tie-breaking.
  let best = candidates[0]!;
  for (const c of candidates) {
    if (Number.isFinite(c.ece) && c.ece < best.ece) {
      best = c;
    }
  }
  return { method: best.method, params: best.params, eceAfter: best.ece };
}

// ────────────────────────────────────────────────────────────────
// Isotonic encoding (quantile-binned breakpoints)
// ────────────────────────────────────────────────────────────────

/** Number of quantile bins used to encode an isotonic table. 10 matches
 *  the resolver-side `applyIsotonicFallback` default expectation and is
 *  the standard for reliability diagrams. */
const ISOTONIC_BIN_COUNT = 10;

function encodeIsotonicBreakpoints(rows: readonly TraceRow[]): Record<string, number> {
  if (rows.length === 0) {
    return { breakpoint_count: 0 };
  }
  // sort by score ascending; deterministic tie-break by isCorrect.
  const sorted = rows.slice().sort((a, b) => {
    if (a.score < b.score) return -1;
    if (a.score > b.score) return 1;
    if (a.isCorrect && !b.isCorrect) return 1;
    if (!a.isCorrect && b.isCorrect) return -1;
    return 0;
  });

  const N = sorted.length;
  const binSize = Math.max(1, Math.floor(N / ISOTONIC_BIN_COUNT));
  const breakpoints: { x: number; y: number }[] = [];

  for (let bin = 0; bin < ISOTONIC_BIN_COUNT; bin += 1) {
    const start = bin * binSize;
    const end = bin === ISOTONIC_BIN_COUNT - 1 ? N : Math.min(N, start + binSize);
    if (start >= end) break;
    let scoreSum = 0;
    let correctSum = 0;
    for (let i = start; i < end; i += 1) {
      scoreSum += sorted[i]!.score;
      correctSum += sorted[i]!.isCorrect ? 1 : 0;
    }
    breakpoints.push({
      x: scoreSum / (end - start),
      y: correctSum / (end - start),
    });
  }

  // Enforce isotonic (monotone-non-decreasing y) via pool-adjacent-violators.
  // Without this the resolver-side guard rejects the params at runtime.
  for (let i = 1; i < breakpoints.length; i += 1) {
    if (breakpoints[i]!.y < breakpoints[i - 1]!.y) {
      breakpoints[i] = { x: breakpoints[i]!.x, y: breakpoints[i - 1]!.y };
    }
  }

  const out: Record<string, number> = { breakpoint_count: breakpoints.length };
  for (let i = 0; i < breakpoints.length; i += 1) {
    out[`x_${String(i)}`] = breakpoints[i]!.x;
    out[`y_${String(i)}`] = breakpoints[i]!.y;
  }
  return out;
}

function evaluateIsotonicBreakpoints(params: Record<string, number>, rawScore: number): number {
  const count = params['breakpoint_count'] ?? 0;
  if (count === 0) return Math.max(0, Math.min(1, rawScore));
  let prevX = -Infinity;
  let prevY = 0;
  let lastY = 0;
  for (let i = 0; i < count; i += 1) {
    const x = params[`x_${String(i)}`];
    const y = params[`y_${String(i)}`];
    if (x === undefined || y === undefined) return Math.max(0, Math.min(1, rawScore));
    if (rawScore <= x) {
      if (i === 0 || x === prevX) return Math.max(0, Math.min(1, y));
      const t = (rawScore - prevX) / Math.max(Number.EPSILON, x - prevX);
      return Math.max(0, Math.min(1, prevY + t * (y - prevY)));
    }
    prevX = x;
    prevY = y;
    lastY = y;
  }
  return Math.max(0, Math.min(1, lastY));
}

// ────────────────────────────────────────────────────────────────
// Per-class fit orchestration
// ────────────────────────────────────────────────────────────────

export function fitAllClasses(
  rows: readonly TraceRow[],
  holdoutRatio: number,
  seed: number,
): { fits: readonly ClassFitOutcome[]; skipped: readonly { queryClass: string; reason: string }[] } {
  // Bucket by queryType. Rows without queryType go into the synthetic
  // 'unknown' bucket so they still contribute to a global fit when the
  // pipeline runs against legacy traces.
  const byClass = new Map<string, TraceRow[]>();
  for (const r of rows) {
    const qc: string = r.queryType ?? 'unknown';
    const bucket = byClass.get(qc);
    if (bucket !== undefined) {
      bucket.push(r);
    } else {
      byClass.set(qc, [r]);
    }
  }

  const fits: ClassFitOutcome[] = [];
  const skipped: { queryClass: string; reason: string }[] = [];
  // Stable iteration order — sort class names alphabetically so the report
  // is reproducible across runs.
  const classNames = Array.from(byClass.keys()).sort();
  for (const qc of classNames) {
    if (!isQueryClass(qc)) {
      skipped.push({ queryClass: qc, reason: 'not_a_known_query_class' });
      continue;
    }
    const classRows = byClass.get(qc) ?? [];
    const positives = classRows.filter((r) => r.isCorrect).length;
    const negatives = classRows.length - positives;
    if (
      positives < PER_CLASS_MIN_PER_LABEL ||
      negatives < PER_CLASS_MIN_PER_LABEL
    ) {
      skipped.push({
        queryClass: qc,
        reason: `insufficient_class_balance (pos=${String(positives)}, neg=${String(negatives)})`,
      });
      continue;
    }
    let split: StratifiedSplit;
    try {
      split = stratifiedHoldoutSplit(classRows, holdoutRatio, seed);
    } catch (err) {
      skipped.push({ queryClass: qc, reason: `split_failed: ${(err as Error).message}` });
      continue;
    }
    const eceBefore = computeECE(
      split.holdout.map((r) => ({ confidence: r.score, correct: r.isCorrect })),
    ).ece;
    const winner = pickWinningMethodOnHoldout(split.train, split.holdout);
    const trainSuite = buildCalibrationReport(
      split.train.map((r) => ({ score: r.score, correct: r.isCorrect })),
    );
    fits.push({
      queryClass: qc,
      method: winner.method,
      params: winner.params,
      eceBefore,
      eceAfter: winner.eceAfter,
      aurc: trainSuite.aurc.aurc,
      sampleSize: classRows.length,
    });
  }

  return { fits, skipped };
}

// ────────────────────────────────────────────────────────────────
// Hashing
// ────────────────────────────────────────────────────────────────

export function hashDataset(rows: readonly TraceRow[]): string {
  const hash = createHash('sha256');
  // Hash a normalised stream so re-ordering doesn't change the hash.
  const sorted = rows.slice().sort((a, b) => {
    if (a.score < b.score) return -1;
    if (a.score > b.score) return 1;
    return (a.isCorrect ? 1 : 0) - (b.isCorrect ? 1 : 0);
  });
  for (const r of sorted) {
    hash.update(`${String(r.score)}|${String(r.isCorrect)}|${r.queryType ?? ''}\n`);
  }
  return hash.digest('hex');
}

// ────────────────────────────────────────────────────────────────
// PG factory
// ────────────────────────────────────────────────────────────────

function createPool(): Pool {
  return createScriptPgPool();
}

// ────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: FitCliArgs;
  try {
    const parsed = parseFitArgs(process.argv.slice(2));
    if ('help' in parsed) {
      process.stdout.write(HELP_TEXT);
      return;
    }
    args = parsed;
  } catch (err) {
    process.stderr.write(`[fit-calibration] usage error: ${(err as Error).message}\n\n${HELP_TEXT}`);
    process.exit(EXIT_USAGE);
    return;
  }

  const inputPath = resolve(process.cwd(), args.input);
  const content = await readFile(inputPath, 'utf8');
  const rows = parseTraceNdjson(content);
  if (rows.length < args.minSamples) {
    process.stderr.write(
      `[fit-calibration] insufficient samples: ${String(rows.length)} < ${String(args.minSamples)}. ` +
        `Refusing fit (no heuristic fallback — AdmissionGate trust will expire naturally).\n`,
    );
    process.exit(EXIT_RUNTIME);
    return;
  }

  const { fits, skipped } = fitAllClasses(rows, args.holdoutRatio, args.seed);
  if (fits.length === 0) {
    process.stderr.write(
      `[fit-calibration] no query class produced a usable fit. Skipped: ${JSON.stringify(skipped)}\n`,
    );
    process.exit(EXIT_RUNTIME);
    return;
  }

  const fittedAtIso = new Date().toISOString();
  const datasetHash = hashDataset(rows);
  const report: AggregateReport = {
    fittedAt: fittedAtIso,
    datasetHash,
    totalSamples: rows.length,
    classFits: fits,
    skippedClasses: skipped,
  };

  // Always print a summary to stderr (machine-friendly stdout reserved for JSON).
  const summaryLines = [
    `[fit-calibration] fitted ${String(fits.length)} query classes (skipped ${String(skipped.length)}).`,
    `  dataset hash: ${datasetHash}`,
    `  total samples: ${String(rows.length)}`,
  ];
  for (const f of fits) {
    summaryLines.push(
      `  - ${f.queryClass}: method=${f.method}, ECE ${f.eceBefore.toFixed(4)} → ${f.eceAfter.toFixed(4)}, ` +
        `AURC=${f.aurc.toFixed(4)}, N=${String(f.sampleSize)}`,
    );
  }
  process.stderr.write(`${summaryLines.join('\n')}\n`);

  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  // Write report.
  const reportTimestamp = fittedAtIso.replace(REPORT_TIMESTAMP_REGEX, '-');
  const reportPath = resolve(process.cwd(), join(args.reportDir, `${reportTimestamp}.json`));
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stderr.write(`[fit-calibration] wrote report → ${reportPath}\n`);

  // Persist to PG.
  const pool = createPool();
  try {
    const store = new PgCalibrationStore(pool);
    const fittedAt = new Date(fittedAtIso);
    for (const f of fits) {
      const params: CalibrationParams = {
        method: f.method,
        queryClass: f.queryClass,
        params: f.params,
        trainedAt: fittedAt,
        ece: f.eceAfter,
        fittedAt,
        datasetHash,
        sampleSize: f.sampleSize,
      };
      await store.save(f.queryClass, params);
      process.stderr.write(`[fit-calibration] persisted ${f.queryClass} (method=${f.method})\n`);
    }
  } finally {
    await pool.end();
  }
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
    process.stderr.write(`[fit-calibration] fatal: ${(err as Error).message}\n`);
    process.exit(EXIT_RUNTIME);
  });
}
