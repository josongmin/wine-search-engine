/**
 * Invariant: the domain `Entity` model is snapshot-agnostic. A single request
 * runs under a single active snapshot, so the model that crosses the port
 * boundary must not carry `search_snapshot_id`. Adding the field would leak
 * infrastructure into the domain.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import type { Entity } from '../../src/domain/entity/model/entity.js';
import { createCanonicalEntityId } from '../../src/domain/shared/types/index.js';

describe('Entity domain model is snapshot-agnostic', () => {
  it('has no snapshot identifier field', () => {
    const entity: Entity = {
      id: createCanonicalEntityId('opus-one-2018'),
      type: 'wine',
      canonicalLabel: 'Opus One 2018',
      identitySignature: 'sig',
      relations: {},
      attributes: {},
      metadata: { createdAt: new Date(), updatedAt: new Date() },
    };
    const keys = Object.keys(entity);
    expect(keys).not.toContain('search_snapshot_id');
    expect(keys).not.toContain('searchSnapshotId');
  });
});
