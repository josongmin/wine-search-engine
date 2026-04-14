/**
 * Invariant: `EntityRowSnapshotJsonbSchema` no longer exists. Migration 016
 * replaces row-level rollback with pointer-based rollback (see
 * active_search_snapshot), so the Zod schema that backed the per-entity
 * `rollbackToSnapshot` flow is intentionally absent.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';

describe('EntityRowSnapshotJsonbSchema absence', () => {
  it('is not exported from jsonb-schemas', async () => {
    const mod = (await import(
      '../../src/infrastructure/adapter/jsonb-schemas.js'
    )) as Record<string, unknown>;
    expect(mod['EntityRowSnapshotJsonbSchema']).toBeUndefined();
    expect(mod['ValidatedEntityRowSnapshot']).toBeUndefined();
  });
});
