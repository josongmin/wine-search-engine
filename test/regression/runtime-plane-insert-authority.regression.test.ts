/**
 * Invariant: only `scripts/etl/publish-runtime-substrates.ts` issues
 * `INSERT INTO entities|aliases|ambiguity_registry` SQL. Any additional writer
 * violates the single-writer-authority contract established by migration 016.
 *
 * Grep pattern lives here (not ADR/impl plan) so CI can catch drift without
 * a human re-running the audit.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join, basename } from 'node:path';

const ETL_DIR = fileURLToPath(new URL('../../scripts/etl/', import.meta.url));
const AUTHORIZED_WRITER = 'publish-runtime-substrates.ts';

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

const INSERT_PATTERN = /INSERT\s+INTO\s+(entities|aliases|ambiguity_registry)\b/i;

describe('Runtime plane INSERT authority', () => {
  it('only publish-runtime-substrates.ts writes INTO entities/aliases/ambiguity_registry', () => {
    const files = listTsFiles(resolve(ETL_DIR));
    const offenders: string[] = [];
    for (const abs of files) {
      if (basename(abs) === AUTHORIZED_WRITER) continue;
      const src = readFileSync(abs, 'utf8');
      if (INSERT_PATTERN.test(src)) {
        offenders.push(abs.replace(resolve(ETL_DIR), 'scripts/etl'));
      }
    }
    expect(offenders).toEqual([]);
  });
});
