import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readPackageScripts(): Record<string, string> {
  const raw = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { readonly scripts: Record<string, string> };
  return pkg.scripts;
}

describe('benchmark / verification npm scripts parity (ADR-005)', () => {
  const scripts = readPackageScripts();

  const governance = 'tsx scripts/eval/verify-external-fixture-governance.ts';

  it('keeps fixture governance entrypoints on the same command (no silent drift)', () => {
    expect(scripts['eval:fixtures:verify']).toBe(governance);
    expect(scripts['test:verification:fixtures:governance']).toBe(governance);
    expect(scripts['test:verification:fixtures']).toBe(governance);
  });

  it('keeps eval:full wired to offline gate then fixture governance', () => {
    expect(scripts['eval:full']).toBe(
      'npm run eval:offline:gate && npm run eval:fixtures:verify',
    );
  });

  it('keeps exploratory agent runner scripts as direct npx tsx (npm -- forwarding)', () => {
    expect(scripts['bench:agent']).toBe('npx tsx test/benchmark/agent/runner.ts');
    expect(scripts['bench:agent:exploratory']).toBe('npx tsx test/benchmark/agent/runner.ts');
    expect(scripts['benchmark:quick']).toBe('npx tsx test/benchmark/agent/runner.ts --profile quick');
  });

  it('keeps composite verification lanes as shell && chains without nested npm for leaf evals', () => {
    expect(scripts['bench:agent:fixtures']).toContain('&&');
    expect(scripts['bench:agent:fixtures']).not.toMatch(/npm run bench:agent:fixtures:/);
    expect(scripts['test:verification:search']).toContain('&&');
    expect(scripts['test:verification:search']).not.toMatch(/npm run eval:/);
    expect(scripts['test:verification:agent']).toContain('&&');
    expect(scripts['test:verification:agent']).not.toMatch(/npm run bench:agent:fixtures:/);
    expect(scripts['test:verification:perf']).toContain('&&');
    expect(scripts['test:verification:perf']).not.toMatch(/npm run eval:perf:/);
  });
});
