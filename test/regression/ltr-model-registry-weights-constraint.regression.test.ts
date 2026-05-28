import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const INITIAL_SCHEMA_PATH = resolve(
  REPO_ROOT,
  'src/infrastructure/db/migrations/001_initial_schema.sql',
);
const WEIGHTS_CONSTRAINT_MIGRATION_PATH = resolve(
  REPO_ROOT,
  'src/infrastructure/db/migrations/027_ltr_weights_constraint_ssot.sql',
);

const EXACT_LTR_DIMENSION_CHECK_PATTERN = /array_length\(weights,\s*1\)\s*=\s*\d+/u;
const NON_EMPTY_ONE_DIMENSION_VECTOR_PATTERN =
  /array_ndims\(weights\)\s*=\s*1\s+AND\s+array_length\(weights,\s*1\)\s*>=\s*1/iu;

describe('ltr_model_registry weights constraint SSOT', () => {
  it('initial schema does not hardcode a stale exact weight dimension', () => {
    const sql = readFileSync(INITIAL_SCHEMA_PATH, 'utf8');

    expect(sql).not.toMatch(EXACT_LTR_DIMENSION_CHECK_PATTERN);
    expect(sql).toMatch(NON_EMPTY_ONE_DIMENSION_VECTOR_PATTERN);
  });

  it('follow-up migration replaces the old exact-dimension constraint with the SSOT form', () => {
    const sql = readFileSync(WEIGHTS_CONSTRAINT_MIGRATION_PATH, 'utf8');

    expect(sql).toContain('DROP CONSTRAINT IF EXISTS ltr_model_registry_weights_check');
    expect(sql).not.toMatch(EXACT_LTR_DIMENSION_CHECK_PATTERN);
    expect(sql).toMatch(NON_EMPTY_ONE_DIMENSION_VECTOR_PATTERN);
  });
});
