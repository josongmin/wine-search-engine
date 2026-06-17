/**
 * SSoT gate — FUZZY_EDIT_DISTANCE_CONFIDENCE_FACTOR must be defined once.
 */
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');

describe('FUZZY_EDIT_DISTANCE_CONFIDENCE_FACTOR SSoT gate', () => {
  it('numeric definition exists in exactly one file', () => {
    const result = execSync(
      'grep -r "FUZZY_EDIT_DISTANCE_CONFIDENCE_FACTOR = " src/ --include="*.ts" -l',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' },
    ).trim();
    const files = result.split('\n').filter(Boolean);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('fuzzy-match-confidence.ts');
  });

  it('projection and resolver-candidate builders import the SSoT module', () => {
    const projection = execSync(
      'grep -l "fuzzy-match-confidence" src/application/search/entity-lookup-v2/entity-lookup-v2-candidate-projection.ts',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' },
    ).trim();
    const resolverCandidates = execSync(
      'grep -l "fuzzy-match-confidence" src/application/search/search-usecase-resolver-candidates.ts',
      { cwd: PROJECT_ROOT, encoding: 'utf-8' },
    ).trim();
    expect(projection.length).toBeGreaterThan(0);
    expect(resolverCandidates.length).toBeGreaterThan(0);
  });
});
