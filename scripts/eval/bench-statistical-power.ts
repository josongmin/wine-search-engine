#!/usr/bin/env tsx
/**
 * SOTA++ B4: statistical power planning helper for the agent benchmark.
 *
 * Reads a baseline benchmark report and answers:
 *   "Given the per-scenario score variance observed in this baseline, how many
 *    scenarios do we need to detect a Δ pp difference at α=0.05 with power 0.8?"
 *
 * Math:
 *   For a paired comparison the standard two-sided sample-size formula is
 *
 *       n = ((z_{α/2} + z_{β}) · σ_Δ / Δ)²
 *
 *   where σ_Δ is the standard deviation of the per-scenario delta (Δ_i =
 *   current_i − baseline_i). Without a "current" report we estimate σ_Δ
 *   conservatively from the per-scenario score sd in the baseline, scaled
 *   by √2 (the variance of a paired difference is at most 2·σ² when the two
 *   samples are independent; baseline + current of the SAME agent under
 *   noise re-runs are positively correlated, so √2·σ is a safe upper bound).
 *
 * Standard normal quantiles used:
 *   z_{0.025} = 1.96   (two-sided α=0.05)
 *   z_{0.20}  = 0.8416 (power 0.80)
 *
 * Usage:
 *   pnpm exec tsx scripts/eval/bench-statistical-power.ts \
 *     --baseline test/benchmark/agent/results/baseline.json \
 *     --deltas 0.01,0.02,0.05
 *
 *   pnpm exec tsx scripts/eval/bench-statistical-power.ts \
 *     --baseline test/benchmark/agent/results/baseline.json \
 *     --json
 *
 * The script never mutates the baseline file. Output is text by default;
 * `--json` emits structured stdout suitable for nightly logging.
 */

import { promises as fs } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// Two-sided α=0.05.
const Z_ALPHA_OVER_2 = 1.96;
// Power 0.80 → β=0.20 → z_β = 0.8416.
const Z_BETA_POWER_80 = 0.8416;
// Power 0.90 → β=0.10 → z_β = 1.2816.
const Z_BETA_POWER_90 = 1.2816;
// Conservative σ_Δ scale when only baseline σ is known (assumes independent
// samples; positively-correlated re-runs of the same agent will be tighter,
// so this is an upper bound).
const SIGMA_DELTA_SCALE = Math.SQRT2;

const DEFAULT_DELTAS_PP = [0.01, 0.02, 0.03, 0.05] as const;

interface CliArgs {
  readonly baselinePath: string;
  readonly deltasPp: readonly number[];
  readonly emitJson: boolean;
  readonly powerLevels: readonly number[];
}

interface ScenarioRow {
  readonly id: number | string;
  readonly overall: number;
}

interface BaselineSnapshot {
  readonly scenarios: readonly ScenarioRow[];
  readonly sigma: number;
  readonly mean: number;
  readonly n: number;
}

interface PowerRow {
  readonly deltaPp: number;
  readonly power: number;
  readonly nRequired: number;
  readonly nAvailable: number;
  readonly sufficient: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const baselinePath = get('--baseline');
  if (baselinePath === undefined) {
    throw new Error(
      'Missing --baseline <path>. Example: --baseline test/benchmark/agent/results/baseline.json',
    );
  }

  const deltasRaw = get('--deltas');
  const deltasPp = deltasRaw !== undefined
    ? deltasRaw
        .split(',')
        .map((part) => Number.parseFloat(part.trim()))
        .filter((v) => Number.isFinite(v) && v > 0)
    : [...DEFAULT_DELTAS_PP];

  const powersRaw = get('--powers');
  const powerLevels = powersRaw !== undefined
    ? powersRaw
        .split(',')
        .map((part) => Number.parseFloat(part.trim()))
        .filter((v) => Number.isFinite(v) && v > 0 && v < 1)
    : [0.8];

  return {
    baselinePath: resolvePath(baselinePath),
    deltasPp,
    emitJson: has('--json'),
    powerLevels,
  };
}

function zBetaForPower(power: number): number {
  // Closed-form approximation table for the common targets we care about.
  // For arbitrary power, use the conservative 0.80 row — operators who want
  // a non-standard power can pass it explicitly via --powers.
  if (Math.abs(power - 0.8) < 1e-6) return Z_BETA_POWER_80;
  if (Math.abs(power - 0.9) < 1e-6) return Z_BETA_POWER_90;
  // For non-standard power, fall back to 0.80 conservatively and warn.
  console.error(
    `  [POWER] non-standard power=${power} — using z_{0.20}=${Z_BETA_POWER_80} as approximation`,
  );
  return Z_BETA_POWER_80;
}

async function loadBaseline(path: string): Promise<BaselineSnapshot> {
  const raw = await fs.readFile(path, 'utf8');
  // CLAUDE.md rule 12: JSON.parse → unknown → narrow.
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Baseline at ${path} is not an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const results = obj['results'];
  if (!Array.isArray(results)) {
    throw new Error(`Baseline at ${path} missing 'results' array`);
  }

  const scenarios: ScenarioRow[] = [];
  for (const row of results) {
    if (typeof row !== 'object' || row === null) continue;
    const rowRec = row as Record<string, unknown>;
    if (rowRec['skipped'] === true) continue;
    if (typeof rowRec['error'] === 'string') continue;
    const scores = rowRec['scores'];
    if (typeof scores !== 'object' || scores === null) continue;
    const overall = (scores as Record<string, unknown>)['overall'];
    if (typeof overall !== 'number' || !Number.isFinite(overall)) continue;
    const id = rowRec['id'];
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    scenarios.push({ id, overall });
  }

  const n = scenarios.length;
  if (n < 2) {
    throw new Error(`Baseline at ${path} has < 2 usable scenarios (n=${n}); cannot estimate σ.`);
  }
  const mean = scenarios.reduce((s, r) => s + r.overall, 0) / n;
  const variance = scenarios.reduce((s, r) => s + (r.overall - mean) ** 2, 0) / (n - 1);
  const sigma = Math.sqrt(variance);

  return { scenarios, sigma, mean, n };
}

function computeRequiredN(
  deltaPp: number,
  sigmaDelta: number,
  power: number,
): number {
  if (deltaPp <= 0 || sigmaDelta <= 0) return Number.POSITIVE_INFINITY;
  const zBeta = zBetaForPower(power);
  const num = (Z_ALPHA_OVER_2 + zBeta) * sigmaDelta;
  const n = Math.ceil((num / deltaPp) ** 2);
  return Math.max(2, n);
}

function buildPowerTable(
  baseline: BaselineSnapshot,
  deltas: readonly number[],
  powers: readonly number[],
): readonly PowerRow[] {
  const sigmaDelta = baseline.sigma * SIGMA_DELTA_SCALE;
  const rows: PowerRow[] = [];
  for (const delta of deltas) {
    for (const power of powers) {
      const nRequired = computeRequiredN(delta, sigmaDelta, power);
      rows.push({
        deltaPp: delta,
        power,
        nRequired,
        nAvailable: baseline.n,
        sufficient: Number.isFinite(nRequired) && nRequired <= baseline.n,
      });
    }
  }
  return rows;
}

function formatText(baseline: BaselineSnapshot, rows: readonly PowerRow[]): string {
  const lines: string[] = [];
  const sigmaDelta = baseline.sigma * SIGMA_DELTA_SCALE;
  lines.push('SOTA++ Agent Benchmark — Statistical Power Plan');
  lines.push('───────────────────────────────────────────────');
  lines.push(`Baseline scenarios used:    n = ${baseline.n}`);
  lines.push(`Baseline overall mean:      ${baseline.mean.toFixed(4)} (${(baseline.mean * 100).toFixed(1)}%)`);
  lines.push(`Baseline per-scenario σ:    ${baseline.sigma.toFixed(4)}`);
  lines.push(`Implied σ_Δ (×√2 upper):    ${sigmaDelta.toFixed(4)}`);
  lines.push('');
  lines.push('Required n to detect Δ at α=0.05 (two-sided):');
  lines.push('  Δ pp   power   n required   n available   sufficient?');
  for (const r of rows) {
    lines.push(
      `  ${(r.deltaPp * 100).toFixed(2).padStart(5)}  `
      + `${r.power.toFixed(2).padStart(5)}   `
      + `${String(Number.isFinite(r.nRequired) ? r.nRequired : '∞').padStart(10)}    `
      + `${String(r.nAvailable).padStart(11)}   `
      + `${r.sufficient ? 'YES' : 'no'}`,
    );
  }
  lines.push('');
  lines.push('Reading the table:');
  lines.push('  - n required = ((z_{α/2} + z_{β}) · σ_Δ / Δ)²; uses σ_Δ = √2 · σ_baseline.');
  lines.push('  - "sufficient" = n required ≤ n available — i.e. the current scenario');
  lines.push('     set can statistically resolve this lift, NOT that lift is detected.');
  lines.push('  - If a row is "no", either expand scenario count or accept a larger Δ.');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseline = await loadBaseline(args.baselinePath);
  const rows = buildPowerTable(baseline, args.deltasPp, args.powerLevels);

  if (args.emitJson) {
    const out = {
      baseline: {
        path: args.baselinePath,
        n: baseline.n,
        mean: baseline.mean,
        sigma: baseline.sigma,
        sigmaDelta: baseline.sigma * SIGMA_DELTA_SCALE,
      },
      alpha: 0.05,
      zAlphaOver2: Z_ALPHA_OVER_2,
      rows,
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${formatText(baseline, rows)}\n`);
}

// Allow library use (import without executing) by gating on whether this file
// is the CLI entrypoint. Mirrors the runner's pattern.
const isCliEntry = (() => {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  const argv1Resolved = resolvePath(argv1);
  try {
    const here = new URL(import.meta.url).pathname;
    return resolvePath(here) === argv1Resolved;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  main().catch((err: unknown) => {
    console.error('bench-statistical-power failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export {
  buildPowerTable,
  computeRequiredN,
  loadBaseline,
  type BaselineSnapshot,
  type PowerRow,
  Z_ALPHA_OVER_2,
  Z_BETA_POWER_80,
  Z_BETA_POWER_90,
  SIGMA_DELTA_SCALE,
};
