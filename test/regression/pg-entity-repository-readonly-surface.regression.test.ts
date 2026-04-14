/**
 * Invariant: the runtime write path for `entities` is collapsed to a single
 * authority — the ETL publisher in `scripts/etl/publish-runtime-substrates.ts`.
 * `PgEntityRepository` exposes only read methods. Runtime mutation would break
 * the append-only snapshot-scoped PK model from migration 016.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PG_ENTITY_REPO_PATH = fileURLToPath(
  new URL('../../src/infrastructure/adapter/pg-entity-repository.ts', import.meta.url),
);

describe('PgEntityRepository read-only surface', () => {
  it('has no save / update / delete / createSnapshot / rollbackToSnapshot method', () => {
    const src = readFileSync(PG_ENTITY_REPO_PATH, 'utf8');
    expect(src).not.toMatch(/\bsave\s*\(/);
    expect(src).not.toMatch(/\bupdate\s*\(/);
    // word-boundary match would also fire on `delete` built-in operator;
    // scope to method declaration shape.
    expect(src).not.toMatch(/async delete\s*\(/);
    expect(src).not.toMatch(/createSnapshot\s*\(/);
    expect(src).not.toMatch(/rollbackToSnapshot\s*\(/);
  });
});
