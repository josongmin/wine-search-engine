/**
 * Invariant: the TypeScript `AliasRow` interface declares `search_snapshot_id`
 * as a required field. Readers without a snapshot filter must fail at compile
 * time rather than return zero rows at runtime under migration 016's composite
 * PK.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import type { AliasRow } from '../../src/infrastructure/adapter/pg-alias-repository.js';

describe('AliasRow type declares search_snapshot_id', () => {
  it('accepts a full row shape including search_snapshot_id', () => {
    const row: AliasRow = {
      alias_id: 'opus-one-en',
      search_snapshot_id: 'search-snapshot:v1:abc',
      entity_id: 'opus-one-2018',
      alias_type: 'canonical',
      alias_scope: 'global',
      surface_form: 'Opus One',
      normalized_value: 'opus one',
      source: 'curation',
      source_trust: 1.0,
      confidence: 0.9,
      is_suppressed: false,
      created_at: new Date(),
    };
    expect(row.search_snapshot_id).toBe('search-snapshot:v1:abc');
  });
});
