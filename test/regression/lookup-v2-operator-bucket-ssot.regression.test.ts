import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COVERAGE_HOLE_OPERATOR_BUCKETS } from '../../src/domain/resolver/v2/coverage-report.js';

const EXPORT_DRAFTS_SOURCE = path.join(
  process.cwd(),
  'scripts/eval/export-lookup-v2-curation-drafts.ts',
);

describe('lookup-v2 operator bucket SSoT parity (append-only)', () => {
  it('export-lookup-v2-curation-drafts imports CoverageHoleOperatorBucket from coverage-report', () => {
    const source = readFileSync(EXPORT_DRAFTS_SOURCE, 'utf8');
    expect(source).toContain("from '../../src/domain/resolver/v2/coverage-report.js'");
    expect(source).toContain('CoverageHoleOperatorBucket');
    expect(source).not.toMatch(/operatorBucket\?:\s*\n\s*\| 'strict_collision_ambiguous'/);
  });

  it('coverage-report operator buckets stay stable for write-plane routing', () => {
    expect([...COVERAGE_HOLE_OPERATOR_BUCKETS]).toEqual([
      'strict_collision_ambiguous',
      'family_surface_gap',
      'qualified_scope_surface_gap',
      'scope_target_missing',
      'scope_support_needed',
    ]);
  });
});
