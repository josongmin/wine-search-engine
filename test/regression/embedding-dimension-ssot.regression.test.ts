/**
 * Regression: `EMBEDDING_DIMENSION` is the single source of truth for the
 * embedding vector width and MUST stay aligned across the three places
 * where the dimension is materialized:
 *
 *   1. `src/domain/shared/constants/embedding.ts` — canonical SSoT.
 *   2. `scripts/etl/index-to-vespa.ts` — ETL document embeddings.
 *      No local `EMBEDDING_DIM` literal allowed; the file must import
 *      `EMBEDDING_DIMENSION` from `@shared/constants/embedding`.
 *   3. `vespa/app/schemas/wine_entity.sd` — Vespa schema
 *      `tensor<float>(x[N])` declarations on the embedding field AND on
 *      every `query(query_embedding)` rank input.
 *
 * Why append-only:
 *   - Bumping the dimension (e.g. 1024 → 1536) without re-indexing the
 *     full corpus silently produces dim-mismatch errors during ETL OR
 *     all-zero similarity scores at query time (when query/doc widths
 *     drift). This test gates such drifts at unit-test time.
 *
 * Composite-leaf invariant:
 *   `src/domain/shared/constants/embedding.ts` MUST stay import-free
 *   (no `import` statements; type-only imports also forbidden). The
 *   composite-project DAG breaks if `shared/` depends on anything
 *   outside itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSION } from '../../src/domain/shared/constants/embedding.js';

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

const SHARED_EMBEDDING_TS = path.join(
  REPO_ROOT,
  'src/domain/shared/constants/embedding.ts',
);
const ETL_INDEX_TO_VESPA = path.join(
  REPO_ROOT,
  'scripts/etl/index-to-vespa.ts',
);
const VESPA_SCHEMA = path.join(
  REPO_ROOT,
  'vespa/app/schemas/wine_entity.sd',
);

describe('Embedding dimension SSoT (regression)', () => {
  it('canonical EMBEDDING_DIMENSION is a finite positive integer (current: 1024)', () => {
    expect(Number.isInteger(EMBEDDING_DIMENSION)).toBe(true);
    expect(EMBEDDING_DIMENSION).toBeGreaterThan(0);
    // OpenAI text-embedding-3-small native = 1536; truncation supported
    // down to any positive integer; 3072 is the largest model in the family.
    expect(EMBEDDING_DIMENSION).toBeLessThanOrEqual(3072);
    // Current production value — bumping this requires re-indexing the
    // full corpus AND updating the Vespa schema in lockstep.
    expect(EMBEDDING_DIMENSION).toBe(1024);
  });

  it('shared/constants/embedding.ts has no imports (composite-leaf invariant)', () => {
    const src = fs.readFileSync(SHARED_EMBEDDING_TS, 'utf8');
    // Strip block + line comments before scanning so commentary mentioning
    // "import" does not trip the check.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const importLines = stripped
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^import\b/.test(l) || /^export\s+\*\s+from\b/.test(l));
    expect(importLines, `expected zero imports, found: ${importLines.join(' | ')}`).toEqual([]);
  });

  it('scripts/etl/index-to-vespa.ts imports EMBEDDING_DIMENSION from the SSoT', () => {
    const src = fs.readFileSync(ETL_INDEX_TO_VESPA, 'utf8');
    // Tolerate alias OR relative path; both resolve to the same module.
    const importRe =
      /import\s*\{[^}]*\bEMBEDDING_DIMENSION\b[^}]*\}\s*from\s*['"](?:@shared\/constants\/embedding(?:\.js)?|(?:\.{1,2}\/)+src\/domain\/shared\/constants\/embedding\.js)['"]/;
    expect(
      importRe.test(src),
      'ETL must import EMBEDDING_DIMENSION from the shared SSoT module',
    ).toBe(true);
  });

  it('scripts/etl/index-to-vespa.ts has no local EMBEDDING_DIM literal definition', () => {
    const src = fs.readFileSync(ETL_INDEX_TO_VESPA, 'utf8');
    // Forbid any `const|let|var EMBEDDING_DIM[...]=...` (a local
    // shadow of the SSoT). Imports of `EMBEDDING_DIMENSION` are fine.
    const localDefRe = /\b(?:const|let|var)\s+EMBEDDING_DIM\b\s*(?::|=)/;
    expect(
      localDefRe.test(src),
      'ETL must not redefine EMBEDDING_DIM as a local literal',
    ).toBe(false);
    // Belt-and-suspenders: no bare `EMBEDDING_DIM` identifier reference
    // either — every usage must spell out `EMBEDDING_DIMENSION`.
    const bareRefRe = /\bEMBEDDING_DIM\b(?!ENSION)/;
    expect(
      bareRefRe.test(src),
      'ETL must not reference the legacy EMBEDDING_DIM identifier',
    ).toBe(false);
  });

  it('Vespa schema wine_entity.sd field declaration matches EMBEDDING_DIMENSION', () => {
    const sd = fs.readFileSync(VESPA_SCHEMA, 'utf8');
    const fieldMatch = sd.match(
      /field\s+embedding\s+type\s+tensor<float>\(x\[(\d+)\]\)/,
    );
    expect(
      fieldMatch,
      'embedding field tensor declaration not found in wine_entity.sd',
    ).not.toBeNull();
    expect(Number(fieldMatch![1])).toBe(EMBEDDING_DIMENSION);
  });

  it('Vespa schema query(query_embedding) inputs all match EMBEDDING_DIMENSION', () => {
    const sd = fs.readFileSync(VESPA_SCHEMA, 'utf8');
    const queryRe = /query\(query_embedding\)\s+tensor<float>\(x\[(\d+)\]\)/g;
    const dims: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = queryRe.exec(sd)) !== null) {
      dims.push(Number(m[1]));
    }
    expect(
      dims.length,
      'expected at least one query(query_embedding) tensor declaration in wine_entity.sd',
    ).toBeGreaterThan(0);
    for (const d of dims) {
      expect(d).toBe(EMBEDDING_DIMENSION);
    }
  });
});
