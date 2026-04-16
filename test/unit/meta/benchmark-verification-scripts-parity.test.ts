import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readPackageScripts(): Record<string, string> {
  const raw = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { readonly scripts: Record<string, string> };
  return pkg.scripts;
}

describe('benchmark / verification package scripts parity (ADR-005)', () => {
  const scripts = readPackageScripts();

  const governance = 'tsx scripts/eval/verify-external-fixture-governance.ts';

  it('keeps fixture governance entrypoints on the same command (no silent drift)', () => {
    expect(scripts['eval:fixtures:verify']).toBe(governance);
    expect(scripts['test:verification:fixtures:governance']).toBe(governance);
    expect(scripts['test:verification:fixtures']).toBe(governance);
  });

  it('keeps eval:full wired to offline gate then fixture governance', () => {
    expect(scripts['eval:full']).toBe(
      'pnpm run eval:offline:gate && pnpm run eval:fixtures:verify',
    );
  });

  it('keeps exploratory agent runner scripts as direct npx tsx', () => {
    expect(scripts['bench:agent']).toBe('npx tsx test/benchmark/agent/runner.ts');
    expect(scripts['bench:agent:exploratory']).toBe('npx tsx test/benchmark/agent/runner.ts');
    expect(scripts['benchmark:quick']).toBe('npx tsx test/benchmark/agent/runner.ts --profile quick');
  });

  it('keeps messy-search composite lane wired to live noisy eval plus agent runner', () => {
    const messyAgentRunner = 'npx tsx test/benchmark/agent/runner.ts --profile messy-search';
    const messyEntityRunner = 'node --import tsx scripts/eval/run-noisy-entity-eval.ts --output /tmp/noisy-entity-live-results.json --mode hybrid';

    expect(scripts['benchmark:messy:agent']).toBe(messyAgentRunner);
    expect(scripts['benchmark:messy:entity']).toBe(messyEntityRunner);
    expect(scripts['benchmark:messy']).toBe(
      'pnpm run benchmark:messy:entity && pnpm run benchmark:messy:agent',
    );
  });

  it('keeps composite verification lanes as shell && chains without nested pnpm for leaf evals', () => {
    expect(scripts['bench:agent:fixtures']).toContain('&&');
    expect(scripts['bench:agent:fixtures']).not.toMatch(/pnpm run bench:agent:fixtures:/);
    expect(scripts['test:verification:search']).toContain('&&');
    expect(scripts['test:verification:search']).not.toMatch(/pnpm run eval:/);
    expect(scripts['test:verification:agent']).toContain('&&');
    expect(scripts['test:verification:agent']).not.toMatch(/pnpm run bench:agent:fixtures:/);
    expect(scripts['test:verification:perf']).toContain('&&');
    expect(scripts['test:verification:perf']).not.toMatch(/pnpm run eval:perf:/);
  });
});
