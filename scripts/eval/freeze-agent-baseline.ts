#!/usr/bin/env tsx
/**
 * S1.2 — Freeze a frozen agent-benchmark baseline at the current commit.
 *
 * Historical note: the repo-native live agent runner is currently absent
 * (`test/benchmark/agent/runner.ts`). Until that runner is restored, this
 * helper fail-closes instead of pretending to freeze a trustworthy baseline.
 *
 * Usage:
 *   pnpm exec tsx scripts/eval/freeze-agent-baseline.ts
 *   pnpm exec tsx scripts/eval/freeze-agent-baseline.ts --profile nightly
 *   pnpm exec tsx scripts/eval/freeze-agent-baseline.ts -- --concurrency 5
 *
 * Once the runner exists again:
 *   pnpm exec tsx test/benchmark/agent/runner.ts \
 *     --profile standard \
 *     --baseline test/benchmark/agent/results/baseline-<gitsha>.json
 *
 * Exit codes mirror the runner: 0 success, 1 runtime failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Directory where frozen baselines live (gitignored large artifacts policy aside). */
const RESULTS_DIR = path.resolve(process.cwd(), 'test/benchmark/agent/results');
/** Default profile to freeze — the curated, judge-on standard suite. */
const DEFAULT_PROFILE = 'standard';
/** Historical runner path. Absent in the current checkout; checked fail-closed. */
const RUNNER_PATH = path.resolve(process.cwd(), 'test/benchmark/agent/runner.ts');

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
    return `nogit-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  }
  const short = sha.stdout.trim();
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  const dirty = status.status === 0 && status.stdout.trim().length > 0;
  return dirty ? `${short}-dirty` : short;
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(RUNNER_PATH)) {
    console.error('[freeze-baseline] benchmark runner missing: test/benchmark/agent/runner.ts');
    console.error('[freeze-baseline] current repo-native executable lanes are:');
    console.error('  - pnpm run bench:smoke');
    console.error('  - pnpm run bench:agent:export-scenarios-md');
    console.error('  - pnpm run eval:lookup-v2:authority -- --use-active-runtime --output /tmp/entity-resolution-validation.json');
    console.error('  - pnpm run eval:lookup-v2:parity -- --use-active-runtime --output /tmp/lookup-v2-parity-report.json');
    console.error('[freeze-baseline] restore the agent runner before freezing live agent baselines again.');
    process.exitCode = 1;
    return;
  }

  const sha = resolveGitSha();
  const outPath = path.join(RESULTS_DIR, `baseline-${sha}.json`);

  mkdirSync(RESULTS_DIR, { recursive: true });

  const runnerArgs = [
    'exec',
    'tsx',
    RUNNER_PATH,
    '--profile',
    args.profile,
    '--out',
    outPath,
    ...args.passthrough,
  ];

  console.error(`[freeze-baseline] profile=${args.profile} sha=${sha}`);
  console.error(`[freeze-baseline] writing → ${outPath}`);

  const child = spawn('pnpm', runnerArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env },
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });

  if (exitCode === 0) {
    console.error(`[freeze-baseline] baseline frozen at ${outPath}`);
    console.error(
      `[freeze-baseline] diff later runs with:\n`
      + `  pnpm exec tsx test/benchmark/agent/runner.ts --profile ${args.profile} --baseline ${outPath}`,
    );
  } else {
    console.error(`[freeze-baseline] runner exited ${exitCode} — baseline NOT trustworthy`);
    process.exitCode = exitCode;
  }
}

void run();
