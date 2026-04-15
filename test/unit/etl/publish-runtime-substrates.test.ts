import { describe, expect, it } from 'vitest';
import type { EntitySnapshotRecord } from '../../../scripts/etl/search-snapshot-schema.js';
import { assertEntityIdentitySignatureConsistency } from '../../../scripts/etl/publish-runtime-substrates.js';

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

describe('publish-runtime-substrates identity signature guard', () => {
  it('allows an empty batch', async () => {
    const client = {
      query: async () => ({ rows: [] }),
    };

    await expect(
      assertEntityIdentitySignatureConsistency(client, []),
    ).resolves.toBeUndefined();
  });

  it('fails closed when an existing entity_id would be remapped to a new identity signature', async () => {
    const client = {
      query: async () => ({
        rows: [
          {
            entity_id: 'opus-one-2018',
            identity_signature: 'different-signature',
          },
        ],
      }),
    };

    await expect(
      assertEntityIdentitySignatureConsistency(client, [baseEntity()]),
    ).rejects.toThrow(/refusing to remap/);
  });

  it('fails closed when the same identity signature already belongs to a different entity_id', async () => {
    const client = {
      query: async () => ({
        rows: [
          {
            entity_id: 'other-entity',
            identity_signature: 'a'.repeat(64),
          },
        ],
      }),
    };

    await expect(
      assertEntityIdentitySignatureConsistency(client, [baseEntity()]),
    ).rejects.toThrow(/already belongs to entity_id/);
  });
});
