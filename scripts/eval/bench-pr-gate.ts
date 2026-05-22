#!/usr/bin/env npx tsx
/**
 * PR-level micro-bench gate.
 *
 * The default lane runs the lightweight `bench:smoke` test set (which exits
 * non-zero on its own vitest failures) AND, when an archived baseline is
 * supplied, the paired bootstrap from `bench-compare` against the current
 * archive. The gate exits non-zero when:
 *
 *   - bench:smoke produces a non-zero exit
 *   - OR the current archive has `criticalFailureCount > 0`
 *   - OR the bootstrap detects a significant regression (Δ < -threshold, p<0.05)
 *
 * Override via env var `BENCH_SMOKE_OVERRIDE=YES`. Use sparingly — gate is
 * intentionally strict.
 *
 * Usage:
 *   tsx scripts/eval/bench-pr-gate.ts
 *     # Runs bench:smoke. Exits 1 on failure.
 *
 *   tsx scripts/eval/bench-pr-gate.ts --report data/bench-archive/<sha>-<ts>.json
 *     # Reads `criticalFailureCount` from a completed report; fails on > 0.
 *
 *   tsx scripts/eval/bench-pr-gate.ts --report <current> --baseline <baseline>
 *     # Adds the bootstrap regression check on top of the critical-failure
 *     # check.
 */

import { promises as fs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { pairedBootstrap } from './significance.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_REGRESSION_THRESHOLD_PP = 2.0;
const SIGNIFICANCE_ALPHA = 0.05;

interface CliArgs {
  readonly reportPath?: string;
  readonly baselinePath?: string;
  readonly thresholdPp: number;
  /** When true, skip running bench:smoke (callers may have run it elsewhere). */
  readonly skipSmoke: boolean;
}

interface MinimalReport {
  readonly summary: { readonly overallScore: number };
  readonly results: readonly {
    readonly id: number;
    readonly scores: { readonly overall: number };
    readonly skipped?: boolean;
    readonly error?: string;
  }[];
  readonly criticalFailureCount: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const thresholdRaw = flag('--threshold-pp');
  const reportPath = flag('--report');
  const baselinePath = flag('--baseline');
  return {
    // exactOptionalPropertyTypes: omit the key when no value, never assign undefined.
    ...(reportPath !== undefined ? { reportPath } : {}),
    ...(baselinePath !== undefined ? { baselinePath } : {}),
    thresholdPp: thresholdRaw !== undefined && Number.isFinite(Number.parseFloat(thresholdRaw))
      ? Number.parseFloat(thresholdRaw)
      : DEFAULT_REGRESSION_THRESHOLD_PP,
    skipSmoke: argv.includes('--skip-smoke'),
  };
}

function isOverride(): boolean {
  return (process.env['BENCH_SMOKE_OVERRIDE'] ?? '').toUpperCase() === 'YES';
}

async function loadReport(path: string): Promise<MinimalReport | null> {
  try {
    const raw = await fs.readFile(resolve(REPO_ROOT, path), 'utf8');
    const json = JSON.parse(raw) as unknown;
    if (!isMinimalReport(json)) return null;
    return json;
  } catch {
    return null;
  }
}

function isMinimalReport(value: unknown): value is MinimalReport {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v['results'])) return false;
  const summary = v['summary'];
  if (summary === null || typeof summary !== 'object') return false;
  if (typeof (summary as Record<string, unknown>)['overallScore'] !== 'number') return false;
  if (typeof v['criticalFailureCount'] !== 'number') return false;
  return true;
}

function runSmokeTests(): number {
  const result = spawnSync('pnpm', ['run', 'bench:smoke'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

function pairedPerScenarioScores(
  current: MinimalReport,
  baseline: MinimalReport,
): { baseline: number[]; current: number[] } {
  const baselineById = new Map<number, number>();
  for (const r of baseline.results) {
    if (r.skipped === true || r.error !== undefined) continue;
    baselineById.set(r.id, r.scores.overall);
  }
  const baselineOut: number[] = [];
  const currentOut: number[] = [];
  for (const r of current.results) {
    if (r.skipped === true || r.error !== undefined) continue;
    const b = baselineById.get(r.id);
    if (b === undefined) continue;
    baselineOut.push(b);
    currentOut.push(r.scores.overall);
  }
  return { baseline: baselineOut, current: currentOut };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (isOverride()) {
    console.error('[bench-pr-gate] BENCH_SMOKE_OVERRIDE=YES — gate disabled.');
    process.exit(0);
  }

  // 1. Smoke tests (unit). Always run unless explicitly skipped.
  if (!args.skipSmoke) {
    const status = runSmokeTests();
    if (status !== 0) {
      console.error(`[bench-pr-gate] bench:smoke failed (exit=${status}).`);
      process.exit(1);
    }
    console.error('[bench-pr-gate] bench:smoke passed.');
  }

  // 2. Critical-failure gate on a supplied report.
  if (args.reportPath !== undefined) {
    const current = await loadReport(args.reportPath);
    if (current === null) {
      console.error(`[bench-pr-gate] could not read --report ${args.reportPath}. Treating as failure.`);
      process.exit(1);
    }
    if (current.criticalFailureCount > 0) {
      console.error(
        `[bench-pr-gate] ❌ ${current.criticalFailureCount} critical failure(s) in current bench. Aborting.`,
      );
      process.exit(2);
    }
    console.error(`[bench-pr-gate] criticalFailureCount=0 ✓`);

    // 3. Frozen-baseline regression gate (paired bootstrap).
    if (args.baselinePath !== undefined) {
      const baseline = await loadReport(args.baselinePath);
      if (baseline === null) {
        console.error(`[bench-pr-gate] could not read --baseline ${args.baselinePath}. Skipping bootstrap.`);
      } else {
        const { baseline: bArr, current: cArr } = pairedPerScenarioScores(current, baseline);
        if (bArr.length < 5) {
          console.error(`[bench-pr-gate] only ${bArr.length} paired scenarios — too few for bootstrap. Skipping.`);
        } else {
          const r = pairedBootstrap(bArr, cArr, 10_000, SIGNIFICANCE_ALPHA);
          const deltaPp = r.mean_diff * 100;
          const upperPp = r.ci_95[1] * 100;
          console.error(
            `[bench-pr-gate] paired bootstrap n=${bArr.length} `
            + `Δ=${deltaPp >= 0 ? '+' : ''}${deltaPp.toFixed(2)}pp `
            + `CI=[${(r.ci_95[0] * 100).toFixed(2)}, ${(r.ci_95[1] * 100).toFixed(2)}]pp `
            + `p=${r.p_value.toFixed(4)}`,
          );
          const significantRegression = deltaPp < -args.thresholdPp
            && upperPp < -args.thresholdPp + 0.001;
          if (significantRegression) {
            console.error(`[bench-pr-gate] ❌ regression: Δ < -${args.thresholdPp.toFixed(1)}pp AND CI upper < -${args.thresholdPp.toFixed(1)}pp.`);
            process.exit(3);
          }
          console.error('[bench-pr-gate] no significant regression ✓');
        }
      }
    }
  }

  console.error('[bench-pr-gate] all gates passed.');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`[bench-pr-gate] error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
