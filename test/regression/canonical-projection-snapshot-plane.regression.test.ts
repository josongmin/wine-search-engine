/**
 * T-012 canonical projection snapshot-plane migration contract.
 *
 * Legacy canonical projection rows may predate snapshot-bound columns. The
 * migration may backfill only when the canonical root plane proves exactly one
 * authoritative snapshot id; otherwise it must stay fail-closed.
 */
import { describe, expect, it } from 'vitest';

describe('T-012 canonical projection snapshot-plane migration contract', () => {
  it('backfills canonical_ambiguity_registry from a unique canonical root snapshot', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/WITH canonical_root_snapshot AS/);
    expect(src).toMatch(/COUNT\(DISTINCT NULLIF\(source_provenance->>'search_snapshot_id', ''\)\) = 1/);
    expect(src).toMatch(/UPDATE canonical_ambiguity_registry AS car/);
    expect(src).toMatch(/car\.approval_state = 'snapshot_projected'/);
    expect(src).toMatch(/crs\.search_snapshot_id IS NOT NULL/);
  });

  it('retains fail-closed guard for unresolved legacy projection rows', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      fileURLToPath(new URL('../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql', import.meta.url)),
      'utf-8',
    );
    expect(src).toMatch(/canonical_ambiguity_registry contains legacy rows without search_snapshot_id/);
    expect(src).toMatch(/canonical_aliases contains legacy rows without search_snapshot_id/);
  });
});
