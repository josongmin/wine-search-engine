/**
 * Invariant: no ETL script references a mutating method on PgAliasRepository.
 * The previous direct writer (`generate-transliteration-aliases.ts`) was
 * rewritten into an NDJSON producer so all runtime-plane writes flow through
 * `publish-runtime-substrates.ts`.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const ETL_DIR = fileURLToPath(new URL('../../scripts/etl/', import.meta.url));

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const s = statSync(abs);
    if (s.isDirectory()) {
      if (name.startsWith('__')) continue;
      listTsFiles(abs, out);
    } else if (name.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

const FORBIDDEN_MUTATING_CALLERS = [
  /\bnew\s+PgAliasRepository\b[\s\S]*?\.save\s*\(/,
  /\bnew\s+PgAliasRepository\b[\s\S]*?\.suppress\s*\(/,
  /\bnew\s+PgAliasRepository\b[\s\S]*?\.bulkSave\s*\(/,
  /aliasRepo(?:sitory)?\.save\s*\(/,
  /aliasRepo(?:sitory)?\.suppress\s*\(/,
  /aliasRepo(?:sitory)?\.bulkSave\s*\(/,
];

describe('ETL scripts do not call PgAliasRepository mutating methods', () => {
  it('every script in scripts/etl/ is clean', () => {
    const files = listTsFiles(resolve(ETL_DIR));
    const offenders: string[] = [];
    for (const abs of files) {
      const src = readFileSync(abs, 'utf8');
      for (const pat of FORBIDDEN_MUTATING_CALLERS) {
        if (pat.test(src)) {
          offenders.push(`${abs.replace(resolve(ETL_DIR), 'scripts/etl')}: ${pat.source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
