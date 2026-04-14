/**
 * Invariant: `SnapshotHealthSchema.stale_row_count` is bounded at 100M. A
 * runaway reaper lag still serializes up to the ceiling; values beyond the
 * ceiling fail Zod validation so operators see the contract violation rather
 * than silently truncated telemetry.
 *
 * Boundary locked: just-inside and just-outside values tested per
 * bugbash-prevention rule #6.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE_PATH = fileURLToPath(
  new URL('../../src/interface/http/routes/route-contracts.ts', import.meta.url),
);

describe('SnapshotHealthSchema stale_row_count boundary', () => {
  const src = readFileSync(FILE_PATH, 'utf8');

  it('declares a 100M ceiling via SNAPSHOT_HEALTH_STALE_ROWS_MAX', () => {
    expect(src).toMatch(/SNAPSHOT_HEALTH_STALE_ROWS_MAX\s*=\s*100_000_000/);
  });

  it('uses the ceiling in the schema', () => {
    expect(src).toMatch(/stale_row_count:\s*z\.number\(\)\.int\(\)\.nonnegative\(\)\.max\(SNAPSHOT_HEALTH_STALE_ROWS_MAX\)/);
  });

  it('schema is strict (rejects unknown fields)', () => {
    // SnapshotHealthSchema must close the object so ops can't silently add
    // fields without the wire contract acknowledging them.
    expect(src).toMatch(/const SnapshotHealthSchema = z\.object\([\s\S]*?\}\)\.strict\(\);/);
  });
});
