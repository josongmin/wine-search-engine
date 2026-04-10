/**
 * E5-T12: W6-P1-3 — Soft/Hard split-brain gate (meta-test)
 * Verifies SOFT_CONSTRAINT_ATTRIBUTES is defined in exactly one file.
 */
import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

// From test/meta/ → ../.. = project root
const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

describe('SOFT_CONSTRAINT_ATTRIBUTES SSoT gate', () => {
  it('new Set([...]) definition exists in exactly one file', () => {
    const result = execSync(
      'grep -r "SOFT_CONSTRAINT_ATTRIBUTES.*=.*new Set" src/ --include="*.ts" -l',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' },
    ).trim();
    const files = result.split('\n').filter(Boolean);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('constraint-attributes.ts');
  });

  it('no other module redefines SOFT_CONSTRAINT_ATTRIBUTES with new Set', () => {
    const result = execSync(
      'grep -r "SOFT_CONSTRAINT_ATTRIBUTES.*=.*new Set" src/ --include="*.ts"',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' },
    ).trim();
    const lines = result.split('\n').filter(Boolean);
    // Must only be in constraint-attributes.ts
    for (const line of lines) {
      expect(line).toContain('constraint-attributes.ts');
    }
  });
});
