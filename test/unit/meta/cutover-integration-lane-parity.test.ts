import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

describe('cutover integration lane parity', () => {
  const packageJson = JSON.parse(readWorkspaceFile('package.json')) as {
    readonly scripts: Record<string, string>;
  };
  const integrationConfig = readWorkspaceFile('config/vitest/integration.config.ts');
  const nightlyWorkflow = readWorkspaceFile('.github/workflows/nightly-tests.yml');

  it('keeps the ADR-007 cutover namespace seal integration file in the integration lane include set', () => {
    expect(integrationConfig).toContain("include: [");
    expect(integrationConfig).toContain("'test/integration/**/*.test.ts'");
    expect(integrationConfig).not.toContain('test/integration/etl/cutover-namespace-seal.integration.test.ts');
  });

  it('keeps a dedicated package script for the cutover PG lane', () => {
    expect(packageJson.scripts['test:integration:cutover']).toBe(
      'vitest run test/integration/etl/cutover-namespace-seal.integration.test.ts --config config/vitest/integration.config.ts',
    );
  });

  it('runs the cutover PG lane in nightly workflow with a real PG_TEST_URL', () => {
    expect(nightlyWorkflow).toContain('cutover-pg:');
    expect(nightlyWorkflow).toContain('PG_TEST_URL: postgresql://wine:wine_test@localhost:5433/wine_engine_test');
    expect(nightlyWorkflow).toContain('run: pnpm run test:integration:cutover');
  });
});
