#!/usr/bin/env node
/**
 * Calibration report generator.
 *
 * Reads NDJSON of {score, correct} predictions from --input and produces a
 * calibration report (AURC, ECE, Platt, conformal_90, conformal_95,
 * optimal_threshold_5pct/10pct) on stdout. Optionally writes a structured
 * JSON dump to --output for downstream consumption.
 *
 * Usage:
 *   tsx scripts/eval/calibration-report.ts --input data/calibration/preds.ndjson [--output report.json]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import {
  buildCalibrationReport,
  type CalibrationReport,
} from '../../src/domain/calibration/service/calibration-suite.js';

const PredictionSchema = z
  .object({
    score: z.number().finite(),
    correct: z.boolean(),
  })
  .passthrough();

export interface CliArgs {
  readonly input: string;
  readonly output?: string;
  readonly help?: boolean;
}

/** Minimum sample size at which the summary reports calibration metrics with confidence. */
const MIN_RELIABLE_SAMPLE_SIZE = 30;
/** Numeric precision (decimal places) for the human-readable summary. */
const SUMMARY_PRECISION = 4;
/** JSON.stringify indent width for the --output dump. */
const JSON_INDENT = 2;
/** Process exit code on fatal error. */
const EXIT_FATAL = 1;

const HELP_TEXT = `Calibration report generator

Usage:
  tsx scripts/eval/calibration-report.ts --input <file.ndjson> [--output <file.json>]

Options:
  --input, -i    Path to NDJSON predictions file (required). Each line: {"score": N, "correct": bool}
  --output, -o   Optional path to write the full calibration report as pretty JSON
  --help, -h     Show this help text
`;

export function parseArgs(argv: readonly string[]): CliArgs {
  let input = '';
  let output: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--input' || arg === '-i') {
      input = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--output' || arg === '-o') {
      output = argv[i + 1] ?? '';
      i += 1;
    }
  }

  return {
    input,
    ...(output !== undefined && output !== '' ? { output } : {}),
    ...(help ? { help: true } : {}),
  };
}

export async function loadPredictions(
  filePath: string,
): Promise<readonly { score: number; correct: boolean }[]> {
  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const out: { score: number; correct: boolean }[] = [];

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo]?.trim() ?? '';
    if (line === '') continue;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (err) {
      process.stderr.write(
        `[calibration-report] skipping line ${lineNo + 1}: invalid JSON (${(err as Error).message})\n`,
      );
      continue;
    }

    const result = PredictionSchema.safeParse(parsedJson);
    if (!result.success) {
      process.stderr.write(
        `[calibration-report] skipping line ${lineNo + 1}: schema mismatch (${result.error.issues.map((i) => i.message).join('; ')})\n`,
      );
      continue;
    }

    out.push({ score: result.data.score, correct: result.data.correct });
  }

  return out;
}

function formatSummary(report: CalibrationReport): string {
  const { aurc, ece, sampleSize, optimal_threshold_5pct_risk, optimal_threshold_10pct_risk } =
    report;
  const reliability =
    sampleSize < MIN_RELIABLE_SAMPLE_SIZE
      ? ` (WARNING: sample size < ${MIN_RELIABLE_SAMPLE_SIZE}, metrics may be unreliable)`
      : '';

  const lines = [
    `=== Calibration report ===`,
    `  sample size        : ${sampleSize}${reliability}`,
    `  AURC               : ${aurc.aurc.toFixed(SUMMARY_PRECISION)}`,
    `  ECE                : ${ece.ece.toFixed(SUMMARY_PRECISION)}`,
    `  max calib error    : ${ece.maxCalibrationError.toFixed(SUMMARY_PRECISION)}`,
    `  coverage @ risk 5% : ${aurc.coverage_at_risk_5pct.toFixed(SUMMARY_PRECISION)}`,
    `  coverage @ risk 10%: ${aurc.coverage_at_risk_10pct.toFixed(SUMMARY_PRECISION)}`,
    `  optimal thr (5%)   : score>=${optimal_threshold_5pct_risk.threshold.toFixed(SUMMARY_PRECISION)}  coverage=${optimal_threshold_5pct_risk.coverage.toFixed(SUMMARY_PRECISION)}  risk=${optimal_threshold_5pct_risk.risk.toFixed(SUMMARY_PRECISION)}`,
    `  optimal thr (10%)  : score>=${optimal_threshold_10pct_risk.threshold.toFixed(SUMMARY_PRECISION)}  coverage=${optimal_threshold_10pct_risk.coverage.toFixed(SUMMARY_PRECISION)}  risk=${optimal_threshold_10pct_risk.risk.toFixed(SUMMARY_PRECISION)}`,
    ``,
  ];
  return lines.join('\n');
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help === true) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (args.input === '') {
    process.stderr.write(
      `[calibration-report] error: --input is required\n\n${HELP_TEXT}`,
    );
    process.exit(EXIT_FATAL);
  }

  const inputPath = resolve(process.cwd(), args.input);

  let predictions: readonly { score: number; correct: boolean }[];
  try {
    predictions = await loadPredictions(inputPath);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? `file not found: ${inputPath}`
      : `failed to read ${inputPath}: ${(err as Error).message}`;
    process.stderr.write(`[calibration-report] error: ${reason}\n`);
    process.exit(EXIT_FATAL);
    return;
  }

  if (predictions.length === 0) {
    process.stderr.write(
      `[calibration-report] error: no valid predictions found in ${inputPath}\n`,
    );
    process.exit(EXIT_FATAL);
    return;
  }

  const report = buildCalibrationReport(predictions);
  process.stderr.write(formatSummary(report));

  if (args.output !== undefined) {
    const outputPath = resolve(process.cwd(), args.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, JSON_INDENT)}\n`, 'utf8');
    process.stderr.write(`[calibration-report] wrote ${outputPath}\n`);
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
    process.stderr.write(
      `[calibration-report] fatal: ${(err as Error).message}\n`,
    );
    process.exit(EXIT_FATAL);
  });
}
