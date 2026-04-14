/**
 * Invariant: the TypeScript `EntityRow` interface declares `search_snapshot_id`
 * as a required field. Under migration 016 the physical table's PK is
 * (search_snapshot_id, entity_id), so a reader that forgets to bind
 * search_snapshot_id must fail at compile time rather than silently return
 * zero rows at runtime.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import type { EntityRow } from '../../src/infrastructure/adapter/pg-entity-repository.js';

describe('EntityRow type declares search_snapshot_id', () => {
  it('accepts a full row shape including search_snapshot_id', () => {
    const row: EntityRow = {
      entity_id: 'opus-one-2018',
      search_snapshot_id: 'search-snapshot:v1:abc',
      entity_type: 'wine',
      canonical_label: 'Opus One 2018',
      identity_signature: 'sig',
      relations: {},
      attributes: {},
      metadata: {},
      created_at: new Date(),
      updated_at: new Date(),
    };
    expect(row.search_snapshot_id).toBe('search-snapshot:v1:abc');
  });
});
