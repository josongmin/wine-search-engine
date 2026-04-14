/**
 * Invariant: the planner warmup query in container-core-builders.ts filters
 * by `search_snapshot_id`. Reading surface forms across all snapshots would
 * poison the fuzzy-matcher corpus with reaped or stale alias data.
 *
 * When the pointer table is missing (pre-publish), warmup must degrade via
 * the `learning_warmup_disabled_snapshot_pointer_missing` silent-skip counter
 * rather than failing the bootstrap.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE_PATH = fileURLToPath(
  new URL('../../src/config/container-core-builders.ts', import.meta.url),
);

describe('container-core-builders warmup snapshot filter', () => {
  const src = readFileSync(FILE_PATH, 'utf8');

  it('resolves the active snapshot before reading aliases', () => {
    expect(src).toMatch(/resolveActiveSnapshot\s*\(\s*pool\s*\)/);
  });

  it('binds search_snapshot_id in the warmup SELECT', () => {
    expect(src).toMatch(/SELECT DISTINCT surface_form\s*\n?\s*FROM aliases\s*\n?\s*WHERE search_snapshot_id = \$1/);
  });

  it('no longer reads aliases without a snapshot filter', () => {
    expect(src).not.toMatch(/FROM aliases\s+WHERE is_suppressed = FALSE LIMIT 100000/);
  });

  it('increments the learning_warmup silent-skip kind on pointer-missing', () => {
    expect(src).toMatch(/learning_warmup_disabled_snapshot_pointer_missing/);
  });
});
