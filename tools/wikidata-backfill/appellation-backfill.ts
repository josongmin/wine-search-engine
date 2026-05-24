#!/usr/bin/env tsx
/**
 * Silver-record `appellation` backfill CLI.
 *
 * Reads an NDJSON of silver records, calls
 * `matchAppellation(rec.region, rec.country, rec.canonicalLabel)` on each row
 * whose `appellation` is missing, and writes the augmented records to an
 * output NDJSON. Untouched rows pass through unchanged.
 *
 * Once the backfilled silver is indexed to Vespa and the `appellation` field
 * coverage clears the schema-contract threshold, the workaround
 * `applyAppellationDataAvailabilityDemotion`
 * (`src/application/search/search-usecase-pre-route-phase.ts`) is safe to
 * remove. That removal is a separate followup commit — this tool just
 * produces the data.
 *
 * Usage:
 *   pnpm tsx tools/wikidata-backfill/appellation-backfill.ts \
 *     --input data/silver-trackc.ndjson \
 *     --output data/silver-trackc-with-appellation.ndjson
 *
 * Flags:
 *   --input <path>         Required. NDJSON of silver records.
 *   --output <path>        Required. NDJSON written atomically.
 *   --gazetteer <path>     Optional. Defaults to ./appellation-gazetteer.json.
 *   --overwrite-existing   Optional. By default rows already carrying a
 *                          non-empty `appellation` are skipped. Pass this to
 *                          re-resolve them (rare — only when fixing bad data).
 *   --progress-every <n>   Optional. Default 500. Records between progress
 *                          logs.
 *   --help / -h
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { loadAppellationGazetteer, matchAppellation } from './appellation-matcher.js';

// Number of records between progress emissions. Chosen so that ETL operators
// see a heartbeat every few seconds on typical ~5k rec/s silver throughput.
const DEFAULT_PROGRESS_EVERY = 500;

// Maximum acceptable individual line length (bytes). Silver records are
// usually < 16KB; we cap at 1MB as a safety net against runaway lines.
const MAX_LINE_BYTES = 1_048_576;

interface CliArgs {
  readonly input: string;
  readonly output: string;
  readonly gazetteerPath: string | undefined;
  readonly overwriteExisting: boolean;
  readonly progressEvery: number;
}

interface Stats {
  total: number;
  matched: number;
  miss: number;
  alreadySet: number;
  invalid: number;
  bySource: Map<string, number>;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let input: string | undefined;
  let output: string | undefined;
  let gazetteerPath: string | undefined;
  let overwriteExisting = false;
  let progressEvery = DEFAULT_PROGRESS_EVERY;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--input requires a path');
      input = v;
    } else if (arg === '--output') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--output requires a path');
      output = v;
    } else if (arg === '--gazetteer') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--gazetteer requires a path');
      gazetteerPath = v;
    } else if (arg === '--overwrite-existing') {
      overwriteExisting = true;
    } else if (arg === '--progress-every') {
      const v = argv[++i];
      const parsed = Number.parseInt(v ?? '', 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--progress-every requires a positive integer');
      }
      progressEvery = parsed;
    } else if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown CLI flag: ${String(arg)}`);
    }
  }

  if (input === undefined) throw new Error('--input is required');
  if (output === undefined) throw new Error('--output is required');

  return {
    input,
    output,
    gazetteerPath,
    overwriteExisting,
    progressEvery,
  };
}

function printUsageAndExit(code: number): never {
  const usage =
    'Usage:\n'
    + '  appellation-backfill.ts --input <silver.ndjson> --output <silver-out.ndjson>\n'
    + '                          [--gazetteer <path>] [--overwrite-existing]\n'
    + '                          [--progress-every <n>]\n';
  process.stdout.write(usage);
  process.exit(code);
}

interface SilverLike {
  appellation?: string | null;
  region?: string;
  country?: string;
  canonicalLabel?: string;
  [k: string]: unknown;
}

function isObject(value: unknown): value is SilverLike {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readField(rec: SilverLike, key: 'region' | 'country' | 'canonicalLabel'): string {
  const raw = rec[key];
  return typeof raw === 'string' ? raw : '';
}

function hasAppellation(rec: SilverLike): boolean {
  return typeof rec.appellation === 'string' && rec.appellation.length > 0;
}

export interface BackfillRunResult {
  readonly stats: Stats;
  readonly elapsedMs: number;
}

/**
 * Process a single silver record. Pure — returned tuple lets the caller
 * accumulate stats and serialise.
 *
 * Exported so tests can drive the per-record logic without I/O.
 */
export function backfillOneRecord(
  rec: SilverLike,
  opts: {
    readonly overwriteExisting: boolean;
    readonly matcher?: typeof matchAppellation;
  },
): {
  readonly record: SilverLike;
  readonly outcome: 'matched' | 'miss' | 'already_set';
  readonly source?: string;
} {
  if (!opts.overwriteExisting && hasAppellation(rec)) {
    return { record: rec, outcome: 'already_set' };
  }
  const matcher = opts.matcher ?? matchAppellation;
  const region = readField(rec, 'region');
  const country = readField(rec, 'country');
  const canonicalLabel = readField(rec, 'canonicalLabel');
  const match = matcher(region, country.length > 0 ? country : null, canonicalLabel);
  if (match === null) {
    return { record: rec, outcome: 'miss' };
  }
  const updated: SilverLike = { ...rec, appellation: match.appellation };
  return { record: updated, outcome: 'matched', source: match.source };
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(resolve(filePath)), { recursive: true });
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    printUsageAndExit(2);
  }

  // Validate input exists before doing anything.
  try {
    await stat(args.input);
  } catch {
    process.stderr.write(`[appellation-backfill] input not found: ${args.input}\n`);
    process.exit(2);
  }

  // Pre-load the gazetteer once — this also validates the JSON before we
  // start writing the output (fail fast on a corrupt gazetteer).
  const compiled = loadAppellationGazetteer(args.gazetteerPath);
  process.stdout.write(
    `[appellation-backfill] gazetteer loaded: ${compiled.data.entries.length} entries\n`,
  );

  await ensureDir(args.output);
  const tmpOutput = `${args.output}.partial`;

  const stats: Stats = {
    total: 0,
    matched: 0,
    miss: 0,
    alreadySet: 0,
    invalid: 0,
    bySource: new Map<string, number>(),
  };

  const startedAt = performance.now();
  const readStream = createReadStream(args.input, { encoding: 'utf-8' });
  const writeStream = createWriteStream(tmpOutput, { encoding: 'utf-8' });
  const rl = createInterface({ input: readStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (line.length === 0) continue;
    if (line.length > MAX_LINE_BYTES) {
      stats.invalid += 1;
      process.stderr.write(`[appellation-backfill] skipping oversized line (${line.length} bytes)\n`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      stats.invalid += 1;
      if (stats.invalid <= 5) {
        process.stderr.write(`[appellation-backfill] skipping malformed JSON (line ${stats.total + 1})\n`);
      }
      continue;
    }
    stats.total += 1;
    if (!isObject(parsed)) {
      stats.invalid += 1;
      continue;
    }
    const result = backfillOneRecord(parsed, { overwriteExisting: args.overwriteExisting });
    if (result.outcome === 'matched') {
      stats.matched += 1;
      if (result.source !== undefined) {
        stats.bySource.set(result.source, (stats.bySource.get(result.source) ?? 0) + 1);
      }
    } else if (result.outcome === 'miss') {
      stats.miss += 1;
    } else {
      stats.alreadySet += 1;
    }

    writeStream.write(`${JSON.stringify(result.record)}\n`);

    if (stats.total % args.progressEvery === 0) {
      const elapsedSec = (performance.now() - startedAt) / 1000;
      const rate = stats.total / Math.max(elapsedSec, 0.001);
      process.stdout.write(
        `[appellation-backfill] processed ${stats.total} `
          + `(matched=${stats.matched} miss=${stats.miss} skipped=${stats.alreadySet}) `
          + `at ${rate.toFixed(0)} rec/s\n`,
      );
    }
  }

  await new Promise<void>((resolveDone, rejectDone) => {
    writeStream.end((err?: NodeJS.ErrnoException | null) => {
      if (err) rejectDone(err);
      else resolveDone();
    });
  });

  await rename(tmpOutput, args.output);

  const elapsedMs = performance.now() - startedAt;
  printSummary(stats, elapsedMs, args);
}

function printSummary(stats: Stats, elapsedMs: number, args: CliArgs): void {
  const lines: string[] = [];
  lines.push('');
  lines.push('[appellation-backfill] summary');
  lines.push(`  input             : ${args.input}`);
  lines.push(`  output            : ${args.output}`);
  lines.push(`  total records     : ${stats.total}`);
  lines.push(`  matched           : ${stats.matched}`);
  lines.push(`  miss              : ${stats.miss}`);
  lines.push(`  already_set (skip): ${stats.alreadySet}`);
  if (stats.invalid > 0) {
    lines.push(`  invalid (skipped) : ${stats.invalid}`);
  }
  const matchableTotal = stats.matched + stats.miss;
  if (matchableTotal > 0) {
    const pct = (stats.matched / matchableTotal) * 100;
    lines.push(`  match rate        : ${pct.toFixed(2)}%`);
  }
  if (stats.bySource.size > 0) {
    lines.push('  by source:');
    const entries = [...stats.bySource.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    for (const [src, count] of entries) {
      lines.push(`    ${src.padEnd(28)} ${count}`);
    }
  }
  lines.push(`  elapsed           : ${(elapsedMs / 1000).toFixed(2)} s`);
  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);
}

const invokedFromCli = process.argv[1] !== undefined
  && import.meta.url === `file://${process.argv[1]}`;
if (invokedFromCli) {
  void main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`FATAL: ${msg}\n`);
    process.exit(1);
  });
}
