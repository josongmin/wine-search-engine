#!/usr/bin/env npx tsx
/**
 * Compare two archived bench runs using the paired bootstrap from
 * `scripts/eval/significance.ts`.
 *
 * Usage:
 *   tsx scripts/eval/bench-compare.ts <sha-or-archive-base> <sha-or-archive-base>
 *
 *   Each argument is either:
 *     - a full archive file path
 *     - an archive base name (e.g. `df80cc20-2026-05-22T13-45-00`)
 *     - a 7-12 char git sha prefix; the latest archive starting with that prefix is used
 *
 *   --threshold-pp <n>   regression threshold (default 2.0pp); influences the
 *                        exit status when delta < -threshold AND p < 0.05.
 *   --json <out>         write structured comparison to file (in addition to stderr).
 *   --max-rows <n>       limit per-scenario table size (default 30).
 *
 * Output:
 *   stderr — human-readable comparison
 *   stdout — JSON comparison block (machine-readable)
 *   exit   — 0: no significant regression
 *            1: bad input / read failure
 *            2: significant regression detected
 */

import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pairedBootstrap, type BootstrapResult } from './significance.js';
import {
  defaultArchiveDir,
  listArchiveManifests,
  type BenchArchiveManifest,
} from '../../test/benchmark/agent/bench-archive.js';

// ─── constants ────────────────────────────────────────────────────────────
const DEFAULT_REGRESSION_THRESHOLD_PP = 2.0;
const DEFAULT_MAX_ROWS = 30;
const SIGNIFICANCE_ALPHA = 0.05;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ─── types ────────────────────────────────────────────────────────────────

interface CliArgs {
  readonly leftRef: string;
  readonly rightRef: string;
  readonly thresholdPp: number;
  readonly jsonOut?: string;
  readonly maxRows: number;
}

interface MinimalReport {
  readonly timestamp: string;
  readonly model: string;
  readonly judgeModel: string | null;
  readonly summary: {
    readonly overallScore: number;
    readonly environment?: { readonly gitSha?: string };
    readonly environmentHash?: string;
  };
  readonly results: readonly {
    readonly id: number;
    readonly tier: string;
    readonly skipped?: boolean;
    readonly error?: string;
    readonly scores: { readonly overall: number };
  }[];
}

interface PerScenarioRow {
  readonly id: number;
  readonly tier: string;
  readonly leftScore: number | null;
  readonly rightScore: number | null;
  readonly deltaPp: number | null;
}

interface ComparisonOutput {
  readonly left: { readonly ref: string; readonly path: string; readonly timestamp: string };
  readonly right: { readonly ref: string; readonly path: string; readonly timestamp: string };
  readonly overall: {
    readonly leftScore: number;
    readonly rightScore: number;
    readonly deltaPp: number;
    readonly bootstrap: BootstrapResult;
    readonly significantRegression: boolean;
  };
  readonly byScenario: readonly PerScenarioRow[];
  readonly thresholdPp: number;
}

// ─── arg parsing ──────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): CliArgs {
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error('USAGE: bench-compare <left-ref> <right-ref> [--threshold-pp 2.0] [--json out.json] [--max-rows 30]');
    process.exit(1);
  }
  const idx = (flag: string): number => argv.indexOf(flag);
  const flag = (name: string, fallback: string | undefined): string | undefined => {
    const i = idx(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const thresholdRaw = flag('--threshold-pp', undefined);
  const thresholdPp = thresholdRaw !== undefined ? Number.parseFloat(thresholdRaw) : DEFAULT_REGRESSION_THRESHOLD_PP;
  const maxRowsRaw = flag('--max-rows', undefined);
  const maxRows = maxRowsRaw !== undefined ? Number.parseInt(maxRowsRaw, 10) : DEFAULT_MAX_ROWS;
  const jsonOut = flag('--json', undefined);
  return {
    leftRef: positional[0]!,
    rightRef: positional[1]!,
    thresholdPp: Number.isFinite(thresholdPp) ? thresholdPp : DEFAULT_REGRESSION_THRESHOLD_PP,
    ...(jsonOut !== undefined ? { jsonOut } : {}),
    maxRows: Number.isFinite(maxRows) && maxRows > 0 ? maxRows : DEFAULT_MAX_ROWS,
  };
}

// ─── archive lookup ───────────────────────────────────────────────────────

async function resolveArchivePath(ref: string): Promise<string> {
  // 1. Treat as direct file path (relative or absolute).
  const direct = resolve(REPO_ROOT, ref);
  try {
    await fs.access(direct);
    return direct;
  } catch {
    /* fall through */
  }

  // 2. Treat as base name under archive dir.
  const archiveDir = defaultArchiveDir();
  const asBase = join(archiveDir, `${ref}.json`);
  try {
    await fs.access(asBase);
    return asBase;
  } catch {
    /* fall through */
  }

  // 3. Treat as a git-sha prefix: find latest manifest with matching sha.
  const manifests = await listArchiveManifests(archiveDir);
  const match = pickByShaPrefix(manifests, ref);
  if (match !== undefined) {
    return join(archiveDir, match.reportFile);
  }

  throw new Error(`No archive found for ref "${ref}". Looked in ${direct}, ${asBase}, and prefix-match in ${archiveDir}.`);
}

function pickByShaPrefix(
  manifests: readonly BenchArchiveManifest[],
  prefix: string,
): BenchArchiveManifest | undefined {
  const lower = prefix.toLowerCase();
  // Manifests already sorted desc by capturedAt; first match wins.
  for (const m of manifests) {
    if (m.gitSha.toLowerCase().startsWith(lower)) return m;
  }
  return undefined;
}

async function loadReport(path: string): Promise<MinimalReport> {
  const raw = await fs.readFile(path, 'utf8');
  // CLAUDE.md rule 12: parse to unknown then validate the shape we use.
  const json = JSON.parse(raw) as unknown;
  if (!isMinimalReport(json)) {
    throw new Error(`Report at ${path} is missing required fields (summary.overallScore, results[]).`);
  }
  return json;
}

function isMinimalReport(value: unknown): value is MinimalReport {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v['timestamp'] !== 'string') return false;
  if (typeof v['model'] !== 'string') return false;
  if (!Array.isArray(v['results'])) return false;
  const summary = v['summary'];
  if (summary === null || typeof summary !== 'object') return false;
  const s = summary as Record<string, unknown>;
  if (typeof s['overallScore'] !== 'number') return false;
  return true;
}

// ─── comparison logic ─────────────────────────────────────────────────────

function buildPerScenarioRows(left: MinimalReport, right: MinimalReport): readonly PerScenarioRow[] {
  const leftById = new Map<number, number | null>();
  for (const r of left.results) {
    if (r.skipped === true || r.error !== undefined) { leftById.set(r.id, null); continue; }
    leftById.set(r.id, r.scores.overall);
  }
  const rightById = new Map<number, { tier: string; score: number | null }>();
  for (const r of right.results) {
    if (r.skipped === true || r.error !== undefined) { rightById.set(r.id, { tier: r.tier, score: null }); continue; }
    rightById.set(r.id, { tier: r.tier, score: r.scores.overall });
  }
  const allIds = new Set<number>([...leftById.keys(), ...rightById.keys()]);
  const rows: PerScenarioRow[] = [];
  for (const id of allIds) {
    const leftScore = leftById.get(id) ?? null;
    const rightEntry = rightById.get(id);
    const rightScore = rightEntry?.score ?? null;
    const tier = rightEntry?.tier ?? left.results.find((r) => r.id === id)?.tier ?? 'unknown';
    const deltaPp = leftScore !== null && rightScore !== null
      ? (rightScore - leftScore) * 100
      : null;
    rows.push({ id, tier, leftScore, rightScore, deltaPp });
  }
  rows.sort((a, b) => {
    if (a.deltaPp === null && b.deltaPp === null) return a.id - b.id;
    if (a.deltaPp === null) return 1;
    if (b.deltaPp === null) return -1;
    if (a.deltaPp !== b.deltaPp) return a.deltaPp - b.deltaPp;
    return a.id - b.id;
  });
  return rows;
}

function pairedScores(rows: readonly PerScenarioRow[]): { left: number[]; right: number[] } {
  const left: number[] = [];
  const right: number[] = [];
  for (const r of rows) {
    if (r.leftScore === null || r.rightScore === null) continue;
    left.push(r.leftScore);
    right.push(r.rightScore);
  }
  return { left, right };
}

// ─── formatting ───────────────────────────────────────────────────────────

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '   —  ';
  return `${(v * 100).toFixed(1).padStart(5)}%`;
}

function fmtDeltaPp(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '   —   ';
  const s = v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
  return `${s}pp`.padStart(7);
}

function printPerScenarioTable(rows: readonly PerScenarioRow[], maxRows: number): void {
  console.error('\n  ── per-scenario delta (sorted ↑ regressions first) ──');
  console.error('  id     tier                  left    right   Δpp     flag');
  const regressions = rows.filter((r) => r.deltaPp !== null && r.deltaPp < 0);
  const improvements = rows.filter((r) => r.deltaPp !== null && r.deltaPp > 0).reverse();
  const halfPrint = Math.floor(maxRows / 2);
  const printSet = [...regressions.slice(0, halfPrint), ...improvements.slice(0, halfPrint)];
  for (const r of printSet) {
    const flag = (r.deltaPp ?? 0) < -2 ? '❌ regress' : (r.deltaPp ?? 0) > 2 ? '✅ improve' : '';
    console.error(
      `  ${String(r.id).padEnd(6)} ${r.tier.slice(0, 20).padEnd(20)}  ${fmtPct(r.leftScore)}  ${fmtPct(r.rightScore)}  ${fmtDeltaPp(r.deltaPp)}  ${flag}`,
    );
  }
  if (regressions.length + improvements.length > printSet.length) {
    console.error(`  …(${regressions.length + improvements.length - printSet.length} more rows omitted; --max-rows to widen)`);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const leftPath = await resolveArchivePath(args.leftRef);
  const rightPath = await resolveArchivePath(args.rightRef);
  const left = await loadReport(leftPath);
  const right = await loadReport(rightPath);

  const rows = buildPerScenarioRows(left, right);
  const { left: leftPaired, right: rightPaired } = pairedScores(rows);

  const overallLeft = left.summary.overallScore;
  const overallRight = right.summary.overallScore;
  const overallDeltaPp = (overallRight - overallLeft) * 100;

  // pairedBootstrap returns improvement detection (candidate > baseline). For
  // a regression test we re-run with sides flipped; the resulting `mean_diff`
  // sign tells us the direction of the candidate move and p_value is whether
  // the move is statistically significant.
  const bootstrap = pairedBootstrap(leftPaired, rightPaired, 10_000, SIGNIFICANCE_ALPHA);

  const significantRegression = overallDeltaPp < -args.thresholdPp
    && bootstrap.significant === false  // candidate NOT significantly > baseline
    && rowsImply95RegressionCI(bootstrap, args.thresholdPp);

  const output: ComparisonOutput = {
    left: { ref: args.leftRef, path: leftPath, timestamp: left.timestamp },
    right: { ref: args.rightRef, path: rightPath, timestamp: right.timestamp },
    overall: {
      leftScore: overallLeft,
      rightScore: overallRight,
      deltaPp: overallDeltaPp,
      bootstrap,
      significantRegression,
    },
    byScenario: rows,
    thresholdPp: args.thresholdPp,
  };

  // Stderr summary
  console.error('\n══════════════════════════════════════');
  console.error('  BENCH-COMPARE (paired bootstrap)');
  console.error('══════════════════════════════════════');
  console.error(`  Left:    ${leftPath}`);
  console.error(`           model=${left.model}  ts=${left.timestamp}`);
  console.error(`  Right:   ${rightPath}`);
  console.error(`           model=${right.model}  ts=${right.timestamp}`);
  console.error(`  Threshold: ${args.thresholdPp.toFixed(1)}pp`);
  console.error('  ────── overall ───────');
  console.error(`  Overall left:   ${(overallLeft * 100).toFixed(2)}%`);
  console.error(`  Overall right:  ${(overallRight * 100).toFixed(2)}%`);
  console.error(`  Delta:          ${overallDeltaPp >= 0 ? '+' : ''}${overallDeltaPp.toFixed(2)}pp`);
  console.error(`  Bootstrap CI:   [${(bootstrap.ci_95[0] * 100).toFixed(2)}, ${(bootstrap.ci_95[1] * 100).toFixed(2)}]pp · p=${bootstrap.p_value.toFixed(4)}`);
  console.error(`  Regression: ${significantRegression ? '❌ SIGNIFICANT' : 'no'}`);
  printPerScenarioTable(rows, args.maxRows);

  // JSON to stdout
  console.log(JSON.stringify(output, null, 2));

  if (args.jsonOut !== undefined) {
    await fs.writeFile(resolve(REPO_ROOT, args.jsonOut), JSON.stringify(output, null, 2), 'utf8');
    console.error(`\n  [OUT] wrote ${args.jsonOut}`);
  }

  process.exit(significantRegression ? 2 : 0);
}

/**
 * Helper: derive a sided regression decision from the bootstrap output.
 *
 * The paired bootstrap in `significance.ts` runs an improvement test
 * (H1: candidate > baseline). When the candidate has REGRESSED, that test
 * returns `significant=false` plus a negative `mean_diff`. To gate a
 * regression we need:
 *   - mean_diff strongly negative beyond the threshold
 *   - CI upper bound also below the threshold (i.e. not just noise)
 */
function rowsImply95RegressionCI(b: BootstrapResult, thresholdPp: number): boolean {
  const upperPp = b.ci_95[1] * 100;
  return upperPp < -thresholdPp + 0.001; // small epsilon
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
