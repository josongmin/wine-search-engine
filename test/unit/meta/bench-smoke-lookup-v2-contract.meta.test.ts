import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

describe('bench-smoke lookup-v2 contract parity', () => {
  const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
    readonly scripts: Record<string, string>;
  };
  const benchWorkflow = readWorkspaceFile('.github/workflows/bench-smoke.yml');

  it('package.json defines lookup-v2 active-pointer contract proof script', () => {
    expect(packageJson.scripts['eval:lookup-v2:active-pointer:proof:contract']).toContain('--contract-only');
  });

  it('bench-smoke workflow runs the lookup-v2 active-pointer contract gate', () => {
    expect(benchWorkflow).toContain('eval:lookup-v2:active-pointer:proof:contract');
  });
});
