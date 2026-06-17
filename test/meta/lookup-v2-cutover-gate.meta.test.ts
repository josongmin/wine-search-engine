/**
 * Meta gate: cutover eval script is wired in package.json (CI does not run full eval).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

describe('lookup-v2 cutover gate script parity', () => {
  it('package.json defines lookup-v2:cutover-gate', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.['lookup-v2:cutover-gate'];
    expect(script).toBeTypeOf('string');
    expect(script).toContain('run-lookup-v2-parity.ts');
    expect(script).toContain('--use-active-runtime');
  });
});
