/**
 * Invariant: the `AliasRepository` port surface is read-only. Mutating methods
 * (save/suppress/bulkSave) were removed because composite PK from migration 016
 * invalidated the single-column conflict semantics they relied on.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT_PATH = fileURLToPath(
  new URL('../../src/domain/alias/port/alias-repository.port.ts', import.meta.url),
);

describe('AliasRepository port read-only surface', () => {
  it('declares no mutating method signatures', () => {
    const src = readFileSync(PORT_PATH, 'utf8');
    expect(src).not.toMatch(/save\s*\(\s*alias\s*:/);
    expect(src).not.toMatch(/suppress\s*\(/);
    expect(src).not.toMatch(/bulkSave\s*\(/);
  });

  it('declares the expected read methods', () => {
    const src = readFileSync(PORT_PATH, 'utf8');
    expect(src).toMatch(/findByValue\s*\(/);
    expect(src).toMatch(/findByEntity\s*\(/);
    expect(src).toMatch(/findByNormalizedValue\s*\(/);
    expect(src).toMatch(/findFuzzyCandidates\s*\(/);
  });
});
