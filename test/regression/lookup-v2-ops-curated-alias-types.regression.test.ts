/**
 * Ops curated alias type parity — CSR ops-web must not drift from domain SSoT.
 *
 * Append-only test: never delete this file.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALIAS_TYPES } from '../../src/domain/alias/model/alias.js';
import { OPS_CURATED_ALIAS_TYPES } from '../../src/domain/alias/model/ops-curated-alias-types.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const OPS_WEB_API = resolve(PROJECT_ROOT, 'app/entity-lookup-ops-web/src/lib/api.ts');
const WEB_OPS_CURATED_TYPES = resolve(
  PROJECT_ROOT,
  'web/src/shared/constants/ops-curated-alias-types.ts',
);

function readAliasTypesFromConstFile(filePath: string, constName: string): readonly string[] {
  const src = readFileSync(filePath, 'utf8');
  const match = src.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\] as const;`));
  expect(match).not.toBeNull();
  const body = match?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

function readOpsWebAliasTypes(): readonly string[] {
  return readAliasTypesFromConstFile(OPS_WEB_API, 'ALIAS_TYPES');
}

function readWebOpsCuratedAliasTypes(): readonly string[] {
  return readAliasTypesFromConstFile(WEB_OPS_CURATED_TYPES, 'OPS_CURATED_ALIAS_TYPES');
}

describe('lookup-v2 ops curated alias types (SSoT)', () => {
  it('domain OPS_CURATED_ALIAS_TYPES are members of ALIAS_TYPES', () => {
    const domainSet = new Set<string>(ALIAS_TYPES);
    for (const aliasType of OPS_CURATED_ALIAS_TYPES) {
      expect(domainSet.has(aliasType)).toBe(true);
    }
  });

  it('ops-web ALIAS_TYPES mirror OPS_CURATED_ALIAS_TYPES exactly', () => {
    expect(readOpsWebAliasTypes()).toEqual([...OPS_CURATED_ALIAS_TYPES]);
  });

  it('web ops UI shim mirrors OPS_CURATED_ALIAS_TYPES exactly', () => {
    expect(readWebOpsCuratedAliasTypes()).toEqual([...OPS_CURATED_ALIAS_TYPES]);
  });

  it('does not expose machine-derived alias types for hand curation', () => {
    const curated = new Set<string>(OPS_CURATED_ALIAS_TYPES);
    expect(curated.has('canonical')).toBe(false);
    expect(curated.has('derived_initialism')).toBe(false);
    expect(curated.has('catalog_noise_alias')).toBe(false);
  });
});
