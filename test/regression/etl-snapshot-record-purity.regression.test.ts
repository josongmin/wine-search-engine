/**
 * Invariant: ETL NDJSON record types do NOT carry `search_snapshot_id`. The
 * publisher injects `search_snapshot_id` from `manifest.snapshotId` at publish
 * time — that is the SSoT boundary. Leaking the field into the NDJSON records
 * would duplicate the source of truth and invite drift.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import type {
  AliasSnapshotRecord,
  AmbiguityRegistrySnapshotRow,
  EntitySnapshotRecord,
} from '../../scripts/etl/search-snapshot-schema.js';

describe('ETL snapshot records do not carry search_snapshot_id', () => {
  it('EntitySnapshotRecord', () => {
    const record: EntitySnapshotRecord = {
      entityId: 'opus-one-2018',
      entityType: 'wine',
      canonicalLabel: 'Opus One 2018',
      identitySignature: 'sig',
      relations: {},
      attributes: {},
      metadata: {},
    };
    expect('search_snapshot_id' in record).toBe(false);
    expect('searchSnapshotId' in record).toBe(false);
  });

  it('AliasSnapshotRecord', () => {
    const record: AliasSnapshotRecord = {
      aliasId: 'a1',
      entityId: 'e1',
      value: 'Opus One',
      normalizedValue: 'opus one',
      type: 'canonical',
      scope: 'global',
      source: 'etl',
      sourceTrust: 1.0,
      confidencePrior: 0.9,
    };
    expect('search_snapshot_id' in record).toBe(false);
    expect('searchSnapshotId' in record).toBe(false);
  });

  it('AmbiguityRegistrySnapshotRow', () => {
    const record: AmbiguityRegistrySnapshotRow = {
      registryId: 'r1',
      normalizedForm: 'margaux',
      entityIds: ['e1', 'e2'],
      ambiguityTypes: ['wine_vs_region'],
      severity: 'high',
    };
    expect('search_snapshot_id' in record).toBe(false);
    expect('searchSnapshotId' in record).toBe(false);
  });
});
