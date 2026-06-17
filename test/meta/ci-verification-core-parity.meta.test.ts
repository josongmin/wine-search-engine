/**
 * CI verification-core lane must run HTTP contract parity alongside meta gates.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CI_WORKFLOW = path.join(process.cwd(), '.github/workflows/ci.yml');

describe('verification-core CI parity (meta)', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8');

  it('runs test:meta and verify:http-contracts in verification-core', () => {
    const coreSection = workflow.slice(workflow.indexOf('verification-core:'));
    expect(coreSection).toContain('pnpm run test:meta');
    expect(coreSection).toContain('pnpm run verify:http-contracts');
    expect(coreSection).toContain('eval:lookup-v2:active-pointer:proof:contract');
  });
});
