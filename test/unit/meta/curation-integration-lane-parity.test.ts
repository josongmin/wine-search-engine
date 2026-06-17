import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

describe('curation PG integration lane parity', () => {
  const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
    readonly scripts: Record<string, string>;
  };
  const nightlyWorkflow = readWorkspaceFile('.github/workflows/nightly-tests.yml');

  it('keeps a dedicated package script for the curation PG lane', () => {
    expect(packageJson.scripts['test:integration:curation']).toBe(
      'vitest run test/integration/curation/pg-curation-store.integration.test.ts --config config/vitest/integration.config.ts',
    );
  });

  it('runs the curation PG lane in nightly workflow with a real PG_TEST_URL', () => {
    expect(nightlyWorkflow).toContain('curation-pg:');
    expect(nightlyWorkflow).toContain('PG_TEST_URL: postgresql://wine:wine_test@localhost:5433/wine_engine_test');
    expect(nightlyWorkflow).toContain('run: pnpm run test:integration:curation');
  });
});
