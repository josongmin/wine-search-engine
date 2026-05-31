import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();

function readWorkspaceFile(relativePath: string): string {
  return fs.readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

function extractExplicitTestFiles(source: string): string[] {
  return [...source.matchAll(/'((?:test|src)\/[^']+\.test\.ts)'/g)].map((match) => match[1] as string);
}

describe('vitest e2e include parity', () => {
  it('keeps the default e2e lane pointed at the canonical agent HTTP file', () => {
    const configSource = readWorkspaceFile('config/vitest/e2e.config.ts');

    expect(configSource).toContain("'test/e2e/wine-search-api.test.ts'");
    expect(configSource).not.toContain("'test/e2e/agent-api.test.ts'");
  });

  it('keeps every explicit e2e include target backed by a real file', () => {
    const configPaths = [
      'config/vitest/e2e.config.ts',
      'config/vitest/e2e.wine-search.config.ts',
    ] as const;

    for (const configPath of configPaths) {
      const source = readWorkspaceFile(configPath);
      const explicitFiles = extractExplicitTestFiles(source);

      expect(explicitFiles.length).toBeGreaterThan(0);

      for (const relativePath of explicitFiles) {
        expect(
          fs.existsSync(path.join(workspaceRoot, relativePath)),
          `${configPath} includes missing file ${relativePath}`,
        ).toBe(true);
      }
    }
  });
});
