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
  const claimBootstrap = 'tsx scripts/eval/analyze-legacy-claim-bootstrap.ts --out /tmp/legacy-claim-bootstrap-analysis.json';

  it('keeps fixture governance entrypoints on the same command (no silent drift)', () => {
    expect(scripts['eval:fixtures:verify']).toBe(governance);
    expect(scripts['test:verification:fixtures:governance']).toBe(governance);
    expect(scripts['test:verification:fixtures']).toBe(governance);
  });

  it('keeps eval:full wired to offline gate, noisy release gate, then fixture governance', () => {
    expect(scripts['eval:full']).toBe(
      'pnpm run eval:offline:gate && pnpm run test:verification:noisy && pnpm run eval:fixtures:verify && pnpm run eval:claim:bootstrap',
    );
  });

  it('keeps quality and CI lanes wired to the noisy release gate', () => {
    expect(scripts['test:quality']).toBe(
      'vitest run --config config/vitest/quality.config.ts && pnpm run test:verification:noisy',
    );
    expect(scripts['test:quality:nightly']).toBe('pnpm run test:quality');
    expect(scripts['check:ci']).toContain('pnpm run test:verification:noisy');
    expect(scripts['git:prepush']).toContain('pnpm run test:verification:noisy');
    expect(scripts['git:prepush:heavy']).toContain('pnpm run test:verification:noisy');
  });

  it('keeps noisy release verification on slice-aware gate flags', () => {
    expect(scripts['test:verification:noisy']).toContain('--enforce-min-recall-at-3-by-category');
    expect(scripts['test:verification:noisy']).toContain('--enforce-min-recall-at-3-by-language');
    expect(scripts['eval:noisy:gate']).toContain('--enforce-min-recall-at-3-by-category');
    expect(scripts['eval:noisy:gate']).toContain('--enforce-min-recall-at-3-by-language');
  });

  it('keeps smart verification entrypoints on the dedicated wrapper scripts', () => {
    expect(scripts['check:smart']).toBe('node scripts/test/check-smart.mjs');
    expect(scripts['git:prepush:smart']).toBe('node scripts/test/prepush-smart.mjs');
  });

  it('keeps claim bootstrap verification on the dedicated analysis script', () => {
    expect(scripts['eval:claim:bootstrap']).toBe(claimBootstrap);
    expect(scripts['test:verification:claim']).toBe('pnpm run eval:claim:bootstrap');
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
    expect(scripts['test:verification:fixtures:full']).toBe(
      'pnpm run test:verification:search && pnpm run test:verification:agent && pnpm run test:verification:perf && pnpm run test:verification:claim',
    );
    expect(scripts['test:verification:core']).toBe(
      'pnpm run typecheck && pnpm run typecheck:etl && pnpm run test:e2e:contract && pnpm run test:e2e:runtime && pnpm run test:ingest:contract && pnpm run test:verification:noisy && pnpm run test:verification:claim',
    );
  });
});
