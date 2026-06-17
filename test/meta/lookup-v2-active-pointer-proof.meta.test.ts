/**
 * Meta gate: active-runtime proof lane is wired in package.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const PROOF_SCRIPT = path.join(REPO_ROOT, 'scripts/eval/run-lookup-v2-active-pointer-proof.ts');

describe('lookup-v2 active pointer proof lane (meta)', () => {
  it('package.json defines eval:lookup-v2:active-pointer:proof', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.['eval:lookup-v2:active-pointer:proof'];
    expect(script).toBeTypeOf('string');
    expect(script).toContain('run-lookup-v2-active-pointer-proof.ts');
  });

  it('proof script exists and references active runtime snapshot pointer', () => {
    const source = fs.readFileSync(PROOF_SCRIPT, 'utf8');
    expect(source).toContain('active');
    expect(source).toMatch(/snapshot|runtime/i);
    expect(source).toContain('--contract-only');
    expect(source).toContain('runtime-binding-args');
  });

  it('package.json defines contract-only active-pointer proof entrypoint', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.['eval:lookup-v2:active-pointer:proof:contract'];
    expect(script).toContain('--contract-only');
  });
});
