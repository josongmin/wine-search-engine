import { describe, expect, it } from 'vitest';
import {
  buildCanonicalAliasSyncRows,
  buildCanonicalAmbiguitySyncRows,
  buildCanonicalGraphSyncPayloads,
  CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
  ENTITY_SOURCE_LINK_KIND_SILVER_ROW,
} from '../../../scripts/etl/canonical-entity-graph-sync.js';
import type { EntitySnapshotRecord } from '../../../scripts/etl/search-snapshot-schema.js';

function baseEntity(overrides: Partial<EntitySnapshotRecord> = {}): EntitySnapshotRecord {
  return {
    entityId: 'opus-one-2018',
    entityType: 'wine',
    canonicalLabel: 'Opus One 2018',
    identitySignature: 'a'.repeat(64),
    relations: {},
    attributes: { vintage: 2018, style: 'red' },
    metadata: {
      identityResolution: 'gold_overlay',
      producer: 'Opus One',
      country: 'United States',
      region: 'Napa Valley',
      sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'vivino-opus' }],
    },
    ...overrides,
  };
}

describe('canonical-entity-graph-sync', () => {
  it('builds canonical + link rows from snapshot entity metadata', () => {
    const { canonicalRows, linkRows } = buildCanonicalGraphSyncPayloads(
      [baseEntity()],
      'search-snapshot:v1:test',
    );
    expect(canonicalRows).toHaveLength(1);
    expect(linkRows).toHaveLength(1);
    expect(canonicalRows[0]).toMatchObject({
      canonical_entity_id: 'opus-one-2018',
      entity_type: 'wine',
      canonical_label: 'Opus One 2018',
      producer_ref: 'Opus One',
      region_ref: 'Napa Valley',
      vintage: 2018,
      approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
    });
    expect((canonicalRows[0]?.source_provenance as { search_snapshot_id?: string }).search_snapshot_id).toBe(
      'search-snapshot:v1:test',
    );
    expect(linkRows[0]).toMatchObject({
      canonical_entity_id: 'opus-one-2018',
      source_system: 'vivino-silver',
      source_record_id: 'vivino-opus',
      link_kind: ENTITY_SOURCE_LINK_KIND_SILVER_ROW,
      confidence: 1,
      approved: true,
    });
  });

  it('rejects entities without identityResolution / sourceRecordRefs', () => {
    expect(() =>
      buildCanonicalGraphSyncPayloads(
        [
          baseEntity({
            metadata: { producer: 'X' },
          }),
        ],
        'snap',
      ),
    ).toThrow(/invalid graph sync metadata/);
  });

  it('rejects duplicate canonical_entity_id in one batch', () => {
    const row = baseEntity();
    expect(() => buildCanonicalGraphSyncPayloads([row, { ...row }], 'snap')).toThrow(/duplicate canonical_entity_id/);
  });

  it('maps alias snapshot records to canonical_aliases rows', () => {
    const rows = buildCanonicalAliasSyncRows([
      {
        aliasId: 'aid-1',
        entityId: 'opus-one-2018',
        value: 'Opus One',
        normalizedValue: 'opus one',
        type: 'canonical',
        scope: 'global',
        source: 'snapshot:test',
        sourceTrust: 1,
        confidencePrior: 1,
      },
    ]);
    expect(rows[0]).toMatchObject({
      alias_id: 'aid-1',
      canonical_entity_id: 'opus-one-2018',
      surface_form: 'Opus One',
      normalized_surface: 'opus one',
      approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
    });
  });

  it('maps ambiguity snapshot rows for canonical_ambiguity_registry json payloads', () => {
    const rows = buildCanonicalAmbiguitySyncRows([
      {
        registryId: 'reg-1',
        normalizedForm: 'margaux',
        entityIds: ['chateau-margaux-2015', 'other-2015'],
        ambiguityTypes: ['surface_form_collision'],
        severity: 'medium',
      },
    ]);
    expect(rows[0]).toMatchObject({
      registry_id: 'reg-1',
      normalized_form: 'margaux',
      canonical_entity_ids: ['chateau-margaux-2015', 'other-2015'],
      approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
    });
  });
});
