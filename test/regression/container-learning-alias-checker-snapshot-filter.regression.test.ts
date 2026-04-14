/**
 * Invariant: the inline `buildPgAliasChecker` in container-learning.ts binds
 * `search_snapshot_id` to its "known surface form" check. Without the filter
 * reaped snapshots' aliases would silently pass validation.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE_PATH = fileURLToPath(
  new URL('../../src/config/container-learning.ts', import.meta.url),
);

describe('container-learning alias checker snapshot filter', () => {
  const src = readFileSync(FILE_PATH, 'utf8');

  it('resolves the active snapshot before the alias-existence lookup', () => {
    expect(src).toMatch(/resolveActiveSnapshot\s*\(\s*pool\s*\)/);
  });

  it('binds search_snapshot_id in the alias-existence SELECT', () => {
    expect(src).toMatch(/SELECT 1 FROM aliases[\s\S]*?search_snapshot_id = \$2/);
  });

  it('increments the alias_checker silent-skip kind on pointer-missing', () => {
    expect(src).toMatch(/alias_checker_disabled_snapshot_pointer_missing/);
  });

  it('no longer issues an unfiltered SELECT on aliases', () => {
    expect(src).not.toMatch(/SELECT 1 FROM aliases\s+WHERE surface_form = \$1 AND is_suppressed = FALSE\s+LIMIT 1/);
  });
});
