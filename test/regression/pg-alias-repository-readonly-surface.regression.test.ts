/**
 * Invariant: the runtime write path for `aliases` is collapsed to a single
 * authority — the ETL publisher in `scripts/etl/publish-runtime-substrates.ts`.
 * `PgAliasRepository` exposes only read methods. The previous
 * `save`/`suppress`/`bulkSave` methods had a single-column `ON CONFLICT (alias_id)`
 * target that became invalid under the composite PK from migration 016.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PG_ALIAS_REPO_PATH = fileURLToPath(
  new URL('../../src/infrastructure/adapter/pg-alias-repository.ts', import.meta.url),
);

describe('PgAliasRepository read-only surface', () => {
  it('has no save / suppress / bulkSave method', () => {
    const src = readFileSync(PG_ALIAS_REPO_PATH, 'utf8');
    expect(src).not.toMatch(/async save\s*\(/);
    expect(src).not.toMatch(/async suppress\s*\(/);
    expect(src).not.toMatch(/async bulkSave\s*\(/);
  });
});
