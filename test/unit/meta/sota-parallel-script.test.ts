import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SOTA parallel gate script parity', () => {
  const workspaceRoot = process.cwd();
  const scriptPath = path.join(workspaceRoot, 'scripts/eval/run-sota-parallel.sh');
  const source = fs.readFileSync(scriptPath, 'utf8');

  it('keeps the noisy lane at release-grade verification instead of validate-only', () => {
    expect(source).toContain('run_job "eval-noisy-gate" pnpm run test:verification:noisy');
    expect(source).not.toContain('run_job "eval-noisy-validate" pnpm run eval:noisy:validate');
  });
});
