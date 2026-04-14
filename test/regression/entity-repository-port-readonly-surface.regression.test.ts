/**
 * Invariant: the runtime `EntityRepository` port surface is read-only. Mutating
 * methods (save/update/delete/createSnapshot/rollbackToSnapshot) were removed
 * when migration 016 collapsed the runtime write path to the ETL publisher.
 *
 * Carve-out: `src/domain/ingestion/service/entity-matcher.ts` declares a
 * SEPARATE `EntityRepository` interface (ingestion-side, not runtime lookup).
 * That interface is out of scope and must not be conflated.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT_PATH = fileURLToPath(
  new URL('../../src/domain/entity/port/entity-repository.port.ts', import.meta.url),
);

describe('EntityRepository runtime port read-only surface', () => {
  it('declares no mutating method signatures', () => {
    const src = readFileSync(PORT_PATH, 'utf8');
    expect(src).not.toMatch(/\bsave\s*\(/);
    expect(src).not.toMatch(/\bupdate\s*\(/);
    expect(src).not.toMatch(/\bdelete\s*\(/);
    expect(src).not.toMatch(/createSnapshot\s*\(/);
    expect(src).not.toMatch(/rollbackToSnapshot\s*\(/);
  });

  it('declares the expected read methods', () => {
    const src = readFileSync(PORT_PATH, 'utf8');
    expect(src).toMatch(/findById\s*\(/);
    expect(src).toMatch(/findBySignature\s*\(/);
    expect(src).toMatch(/findByType\s*\(/);
  });
});
