/**
 * Invariant: the runtime plane publisher uses composite-PK conflict targets
 * for all 3 INSERT statements (entities, aliases, ambiguity_registry). A
 * regression to single-column `ON CONFLICT (entity_id)` / `(alias_id)` /
 * `(registry_id)` would reintroduce the cross-snapshot overwrite bug that
 * migration 016 fixed.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PUBLISHER_PATH = fileURLToPath(
  new URL('../../scripts/etl/publish-runtime-substrates.ts', import.meta.url),
);

describe('publish-runtime-substrates.ts composite conflict targets', () => {
  const src = readFileSync(PUBLISHER_PATH, 'utf8');

  it('entities uses ON CONFLICT (search_snapshot_id, entity_id)', () => {
    expect(src).toMatch(/ON CONFLICT \(search_snapshot_id, entity_id\)/);
  });

  it('aliases uses ON CONFLICT (search_snapshot_id, alias_id)', () => {
    expect(src).toMatch(/ON CONFLICT \(search_snapshot_id, alias_id\)/);
  });

  it('ambiguity_registry uses ON CONFLICT (search_snapshot_id, registry_id)', () => {
    expect(src).toMatch(/ON CONFLICT \(search_snapshot_id, registry_id\)/);
  });

  it('does NOT re-introduce single-column conflict targets', () => {
    expect(src).not.toMatch(/ON CONFLICT \(entity_id\)/);
    expect(src).not.toMatch(/ON CONFLICT \(alias_id\)/);
    expect(src).not.toMatch(/ON CONFLICT \(registry_id\)/);
  });

  it('entity_snapshots INSERT is append-only DO NOTHING', () => {
    expect(src).toMatch(/ON CONFLICT \(snapshot_id\) DO NOTHING/);
    // Must not revert to DO UPDATE — that would allow archive rewrites.
    expect(src).not.toMatch(/ON CONFLICT \(snapshot_id\) DO UPDATE/);
  });
});
