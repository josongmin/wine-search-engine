#!/usr/bin/env tsx
/**
 * Resolver Calibration Fitter (RFC-006 §6).
 *
 * Trains per-query-class calibration parameters (Platt scaling, temperature
 * scaling, isotonic regression via PAV) from labelled samples of resolver
 * raw scores and writes the best-by-ECE method to PostgreSQL's
 * `calibration_params` table. The PgCalibrationStore reads from this table
 * at runtime; without this script's output, the resolver falls back to
 * identity-scaling and the AdmissionGate's confidence floor becomes
 * meaningless because the C it gates on is uncalibrated.
 *
 * Input format (NDJSON, one record per line):
 *   {
 *     "query_class": "short_entity",
 *     "raw_score": 0.82,
 *     "label": 1   // 1 = correct top-1 entity, 0 = wrong
 *   }
 *
 * Records with the same `query_class` are pooled. Per class, all three
 * methods are fitted, ECE is measured on the same samples (15 equal-width
 * bins), and the method with the lowest ECE is persisted.
 *
 * Usage:
 *   pnpm exec tsx --env-file=.env scripts/calibrate/fit-resolver-calibration.ts \
 *     --input data/eval-output.jsonl
 *
 * Flags:
 *   --input <path>     NDJSON file of CalibrationInputRecord entries.
 *   --dry-run          Print fitted params per class to stdout; skip PG write.
 *   --query-class <X>  Restrict training to one query class (debug aid).
 *
 * Reference:
 *   - Platt 1999, "Probabilistic Outputs for SVMs"
 *   - Lin et al. 2007, "A Note on Platt's Probabilistic Outputs"
 *   - Guo et al. 2017, "On Calibration of Modern Neural Networks" (Temperature)
 *   - Barlow et al. 1972 (PAV / Isotonic)
 *   - Naeini et al. 2015 (ECE)
 */

import 'dotenv/config';
import fs from 'node:fs/promises';
import {
  fitBestCalibrationWithDiagnostics,
  type CalibrationSample,
} from '../../src/domain/resolver/service/calibration-fitting.js';
import { PgCalibrationStore } from '../../src/infrastructure/adapter/pg-calibration-store.js';
import { createPgPool } from '../../src/infrastructure/db/pg-pool.js';
import { loadConfig } from '../../src/config/env.js';
import type { QueryClass } from '../../src/domain/shared/types/index.js';

interface CalibrationInputRecord {
  readonly query_class: string;
  readonly raw_score: number;
  readonly label: number;
}

const KNOWN_QUERY_CLASSES: ReadonlySet<QueryClass> = new Set<QueryClass>([
  'exact_entity',
  'short_entity',
  'ambiguous_short_form',
  'anchored_similarity',
  'pure_constraint',
  'semantic_preference',
  'comparison_query',
  'unknown',
] as const);

interface CliFlags {
  readonly inputPath: string;
  readonly dryRun: boolean;
  readonly restrictClass: QueryClass | undefined;
}

function parseFlags(argv: readonly string[]): CliFlags {
  let inputPath: string | undefined;
  let dryRun = false;
  let restrictClass: QueryClass | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--input') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('--input requires a path argument');
      }
      inputPath = next;
      i += 1;
    } else if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--query-class') {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new Error('--query-class requires a value');
      }
      if (!KNOWN_QUERY_CLASSES.has(next as QueryClass)) {
        throw new Error(`Unknown query class: ${next}`);
      }
      restrictClass = next as QueryClass;
      i += 1;
    } else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: tsx scripts/calibrate/fit-resolver-calibration.ts --input <ndjson> [--dry-run] [--query-class X]',
      );
      process.exit(0);
    }
  }
  if (inputPath === undefined) {
    throw new Error('--input <path> is required (NDJSON of CalibrationInputRecord entries)');
  }
  return { inputPath, dryRun, ...(restrictClass !== undefined ? { restrictClass } : { restrictClass: undefined }) };
}

function parseRecord(line: string, lineNumber: number): CalibrationInputRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Line ${lineNumber}: invalid JSON — ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Line ${lineNumber}: record must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const queryClass = obj['query_class'];
  const rawScore = obj['raw_score'];
  const label = obj['label'];
  if (typeof queryClass !== 'string' || queryClass.length === 0) {
    throw new Error(`Line ${lineNumber}: query_class must be a non-empty string`);
  }
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) {
    throw new Error(`Line ${lineNumber}: raw_score must be a finite number (got ${String(rawScore)})`);
  }
  if (label !== 0 && label !== 1) {
    throw new Error(`Line ${lineNumber}: label must be 0 or 1 (got ${String(label)})`);
  }
  return { query_class: queryClass, raw_score: rawScore, label };
}

async function loadRecords(inputPath: string): Promise<readonly CalibrationInputRecord[]> {
  const text = await fs.readFile(inputPath, 'utf8');
  const lines = text.split('\n');
  const out: CalibrationInputRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rec = parseRecord(lines[i] ?? '', i + 1);
    if (rec !== null) out.push(rec);
  }
  return out;
}

function groupByQueryClass(
  records: readonly CalibrationInputRecord[],
): ReadonlyMap<QueryClass, readonly CalibrationSample[]> {
  const map = new Map<QueryClass, CalibrationSample[]>();
  for (const rec of records) {
    if (!KNOWN_QUERY_CLASSES.has(rec.query_class as QueryClass)) {
      // Skip unknown classes silently — the dataset may carry experimental
      // class labels the runtime doesn't recognise.
      continue;
    }
    const qc = rec.query_class as QueryClass;
    let bucket = map.get(qc);
    if (bucket === undefined) {
      bucket = [];
      map.set(qc, bucket);
    }
    bucket.push({ rawScore: rec.raw_score, label: rec.label === 1 ? 1 : 0 });
  }
  return map;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const records = await loadRecords(flags.inputPath);
  console.log(`[fit-resolver-calibration] loaded ${records.length} records from ${flags.inputPath}`);

  const grouped = groupByQueryClass(records);
  if (grouped.size === 0) {
    throw new Error('No records grouped — check that records carry recognised query_class values');
  }

  const config = loadConfig();
  const pool = flags.dryRun ? null : createPgPool(config.pg);
  const store = pool !== null ? new PgCalibrationStore(pool) : null;

  for (const [queryClass, samples] of grouped) {
    if (flags.restrictClass !== undefined && queryClass !== flags.restrictClass) {
      continue;
    }
    const diag = fitBestCalibrationWithDiagnostics(samples, queryClass);
    const params = diag.params;
    const positives = samples.filter((s) => s.label === 1).length;
    const negatives = samples.length - positives;
    const eceSource = diag.outOfSample ? 'holdout' : 'in-sample';
    const methodEce = [
      `platt=${diag.methodEce.platt.toFixed(4)}`,
      `temperature=${diag.methodEce.temperature.toFixed(4)}`,
      `isotonic=${diag.methodEce.isotonic.toFixed(4)}`,
    ].join(', ');
    console.log(
      `[fit-resolver-calibration] ${queryClass}: n=${samples.length} (+${positives} / -${negatives}) → ` +
      `method=${params.method}, ECE=${params.ece.toFixed(4)} (${eceSource}), ` +
      `method-ECE=[${methodEce}], params=${JSON.stringify(params.params)}`,
    );
    if (store !== null) {
      await store.save(queryClass, params);
      console.log(`[fit-resolver-calibration] ${queryClass}: saved to calibration_params`);
    }
  }

  if (pool !== null) {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error('[fit-resolver-calibration] FAILED:');
  console.error(message);
  process.exit(1);
});
