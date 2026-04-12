#!/usr/bin/env npx tsx
/**
 * Benchmark PR smoke — no full agent runner, no extra LLM/Vespa beyond what Vitest uses.
 *
 * Runs the lightweight benchmark-related unit tests (retrieval ceiling smoke + CLI entry).
 * For real-stack agent scenarios: `npx tsx test/benchmark/agent/runner.ts --profile quick`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const runner = join(repoRoot, 'scripts/test/run-vitest-lane.mjs');
const config = join(repoRoot, 'config/vitest/dev.config.ts');
const tests = [
  'test/benchmark/agent/__tests__/retrieval-ceiling-smoke.test.ts',
  'test/unit/benchmark/agent/runner-cli-entry.test.ts',
];

const result = spawnSync(process.execPath, [runner, 'run', config, ...tests], {
  cwd: repoRoot,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
