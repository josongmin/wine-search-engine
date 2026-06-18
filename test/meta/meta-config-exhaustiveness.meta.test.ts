/**
 * Meta gate: every test/meta/*.test.ts must be registered in meta.config.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const META_DIR = path.join(REPO_ROOT, 'test/meta');
const META_CONFIG = path.join(REPO_ROOT, 'config/vitest/meta.config.ts');

describe('meta.config include parity', () => {
  const metaConfigSource = readFileSync(META_CONFIG, 'utf8');
  const metaTestFiles = readdirSync(META_DIR)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();

  it('registers every test/meta/*.test.ts file', () => {
    expect(metaTestFiles.length).toBeGreaterThan(0);
    for (const fileName of metaTestFiles) {
      const relativePath = `test/meta/${fileName}`;
      expect(metaConfigSource, `missing include for ${relativePath}`).toContain(relativePath);
    }
  });
});
