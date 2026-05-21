#!/usr/bin/env tsx
/**
 * S1.2 — Freeze a frozen agent-benchmark baseline at the current commit.
 *
 * Runs the standard profile of the agent benchmark and writes the full report
 * JSON to `test/benchmark/agent/results/baseline-<gitsha>.json`. Embedding the
 * short git SHA in the filename keeps every frozen baseline reproducible and
 * traceable to the exact commit it measured — so later runs can diff against a
 * KNOWN reference instead of an aggregate that silently drifts.
 *
 * Usage:
 *   npx tsx scripts/eval/freeze-agent-baseline.ts
 *   npx tsx scripts/eval/freeze-agent-baseline.ts --profile nightly      # override profile
 *   npx tsx scripts/eval/freeze-agent-baseline.ts -- --concurrency 5     # extra runner flags after `--`
 *
 * Then diff a later run against it:
 *   npx tsx test/benchmark/agent/runner.ts \
 *     --profile standard \
 *     --baseline test/benchmark/agent/results/baseline-<gitsha>.json
 *
 * Exit codes mirror the runner: 0 success, 1 runtime failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Directory where frozen baselines live (gitignored large artifacts policy aside). */
const RESULTS_DIR = path.resolve(process.cwd(), 'test/benchmark/agent/results');
/** Default profile to freeze — the curated, judge-on standard suite. */
const DEFAULT_PROFILE = 'standard';

interface Args {
  readonly profile: string;
  /** Extra args forwarded verbatim to the runner (everything after a `--`). */
  readonly passthrough: readonly string[];
}

function parseArgs(argv: readonly string[]): Args {
  let profile = DEFAULT_PROFILE;
  const passthrough: string[] = [];
  let afterDoubleDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (afterDoubleDash) {
      if (arg !== undefined) passthrough.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDoubleDash = true;
    } else if (arg === '--profile') {
      const next = argv[i + 1];
      if (next !== undefined) {
        profile = next;
        i += 1;
      }
    }
  }
  return { profile, passthrough };
}

/**
 * Resolve the short git SHA of HEAD. Appends `-dirty` when the working tree has
 * uncommitted changes so a baseline frozen on a dirty tree is never mistaken for
 * a clean-commit reference. Falls back to a timestamp when git is unavailable.
 */
function resolveGitSha(): string {
  const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  if (sha.status !== 0 || sha.stdout.trim().length === 0) {
    // No git context — use a sortable UTC timestamp so the filename stays unique.
    return `nogit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  const short = sha.stdout.trim();
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const dirty = status.status === 0 && status.stdout.trim().length > 0;
  return dirty ? `${short}-dirty` : short;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sha = resolveGitSha();
  const outPath = path.join(RESULTS_DIR, `baseline-${sha}.json`);

  mkdirSync(RESULTS_DIR, { recursive: true });

  const runnerArgs = [
    'tsx',
    path.resolve(process.cwd(), 'test/benchmark/agent/runner.ts'),
    '--profile',
    args.profile,
    '--out',
    outPath,
    ...args.passthrough,
  ];

  console.error(`[freeze-baseline] profile=${args.profile} sha=${sha}`);
  console.error(`[freeze-baseline] writing → ${outPath}`);

  const child = spawn('npx', runnerArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env },
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });

  if (exitCode === 0) {
    console.error(`[freeze-baseline] ✅ baseline frozen at ${outPath}`);
    console.error(
      `[freeze-baseline] diff later runs with:\n`
      + `  npx tsx test/benchmark/agent/runner.ts --profile ${args.profile} --baseline ${outPath}`,
    );
  } else {
    console.error(`[freeze-baseline] ❌ runner exited ${exitCode} — baseline NOT trustworthy`);
    process.exitCode = exitCode;
  }
}

void run();
