import { describe, expect, it, vi } from 'vitest';
import {
  applyCanonicalEntityGraphSync,
  applyCanonicalAliasAmbiguitySync,
  assertCanonicalEntityIdentitySignatureConsistency,
  assertSourceLinkRemapBlocked,
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
      benchmarkEntityId: 'opus-one-2018',
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
      search_snapshot_id: 'search-snapshot:v1:test',
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
    expect((canonicalRows[0]?.source_provenance as { benchmark_entity_id?: string }).benchmark_entity_id).toBe(
      'opus-one-2018',
    );
    expect(linkRows[0]).toMatchObject({
      search_snapshot_id: 'search-snapshot:v1:test',
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

  it('rejects duplicate identity_signature in one batch even when entity ids differ', () => {
    const row = baseEntity();
    const other = baseEntity({
      entityId: 'opus-one-2020',
      identitySignature: row.identitySignature,
      metadata: {
        ...row.metadata,
        sourceRecordRefs: [{ sourceSystem: 'vivino-silver', sourceRecordId: 'vivino-opus-2020' }],
      },
    });

    expect(() => buildCanonicalGraphSyncPayloads([row, other], 'snap')).toThrow(
      /duplicate identity_signature in snapshot batch/,
    );
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
    ], 'search-snapshot:v1:test');
    expect(rows[0]).toMatchObject({
      search_snapshot_id: 'search-snapshot:v1:test',
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
    ], 'search-snapshot:v1:test');
    expect(rows[0]).toMatchObject({
      search_snapshot_id: 'search-snapshot:v1:test',
      registry_id: 'reg-1',
      normalized_form: 'margaux',
      canonical_entity_ids: ['chateau-margaux-2015', 'other-2015'],
      approval_state: CANONICAL_ENTITY_APPROVAL_SNAPSHOT_PROJECTED,
    });
  });

  it('rejects legacy canonical projection rows without search_snapshot_id before reconcile', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ legacy_rows: '1' }],
      });

    const client = { query } as unknown as Parameters<typeof applyCanonicalAliasAmbiguitySync>[0];

    await expect(
      applyCanonicalAliasAmbiguitySync(client, {
        aliases: [],
        ambiguityRows: [],
        searchSnapshotId: 'search-snapshot:v1:test',
      }),
    ).rejects.toThrow(/legacy row\(s\) without search_snapshot_id/);
  });

  it('reconciles root canonical_entities and entity_source_links without TRUNCATE', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const client = { query } as unknown as Parameters<typeof applyCanonicalEntityGraphSync>[0];

    await applyCanonicalEntityGraphSync(client, {
      entities: [baseEntity()],
      searchSnapshotId: 'search-snapshot:v1:test',
    });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toMatch(/TRUNCATE TABLE canonical_entities/);
    expect(sql).not.toMatch(/TRUNCATE TABLE entity_source_links/);
    expect(sql).toMatch(/canonical_identity_authority/);
    expect(sql).toMatch(/DELETE FROM canonical_entities/);
    expect(sql).toMatch(/DELETE FROM entity_source_links/);
    expect(sql).toMatch(/search_snapshot_id = \$1/);
    expect(sql).toMatch(/ON CONFLICT \(search_snapshot_id, canonical_entity_id\)/);
    expect(sql).toMatch(/ON CONFLICT \(search_snapshot_id, source_system, source_record_id\)/);
  });

  it('reconciles alias and ambiguity projections without TRUNCATE', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const client = { query } as unknown as Parameters<typeof applyCanonicalAliasAmbiguitySync>[0];

    await applyCanonicalAliasAmbiguitySync(client, {
      aliases: [
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
      ],
      ambiguityRows: [
        {
          registryId: 'reg-1',
          normalizedForm: 'margaux',
          entityIds: ['chateau-margaux-2015', 'other-2015'],
          ambiguityTypes: ['surface_form_collision'],
          severity: 'medium',
        },
      ],
      searchSnapshotId: 'search-snapshot:v1:test',
    });

    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toMatch(/TRUNCATE TABLE canonical_aliases/);
    expect(sql).not.toMatch(/TRUNCATE TABLE canonical_ambiguity_registry/);
    expect(sql).toMatch(/DELETE FROM canonical_aliases/);
    expect(sql).toMatch(/DELETE FROM canonical_ambiguity_registry/);
    expect(sql).toMatch(/search_snapshot_id = \$1/);
    expect(sql).toMatch(/ON CONFLICT \(search_snapshot_id, alias_id\)/);
    expect(sql).toMatch(/ON CONFLICT \(search_snapshot_id, registry_id\)/);
  });

  it('rejects existing canonical graph rows that would remap an identity signature', async () => {
    const client = {
      query: async () => ({
        rows: [
          {
            canonical_entity_id: 'opus-one-2018',
            identity_signature: 'different-signature',
          },
        ],
      }),
    } as unknown as Parameters<typeof assertCanonicalEntityIdentitySignatureConsistency>[0];

    const { canonicalRows } = buildCanonicalGraphSyncPayloads([baseEntity()], 'snap');

    await expect(
      assertCanonicalEntityIdentitySignatureConsistency(client, canonicalRows),
    ).rejects.toThrow(/already exists with identity_signature/);
  });

  it('fails closed when canonical root plane contains legacy rows without search_snapshot_id', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ legacy_rows: '1' }],
      });

    const client = { query } as unknown as Parameters<typeof applyCanonicalEntityGraphSync>[0];

    await expect(
      applyCanonicalEntityGraphSync(client, {
        entities: [baseEntity()],
        searchSnapshotId: 'search-snapshot:v1:test',
      }),
    ).rejects.toThrow(/canonical root graph tables contain 1 legacy row/);
  });

  it('rejects source links that point to multiple canonical ids across snapshots', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            source_system: 'vivino-silver',
            source_record_id: 'vivino-opus',
            canonical_entity_ids: ['opus-one-2018', 'opus-one-2020'],
          },
        ],
      }),
    } as unknown as Parameters<typeof assertSourceLinkRemapBlocked>[0];

    await expect(
      assertSourceLinkRemapBlocked(client, [{
        canonical_entity_id: 'opus-one-2018',
        source_system: 'vivino-silver',
        source_record_id: 'vivino-opus',
      }]),
    ).rejects.toThrow(/multiple canonical_entity_id values across snapshots/);
  });
});
