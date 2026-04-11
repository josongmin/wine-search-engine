import { describe, it, expect } from 'vitest';
import { canMerge, merge, canSplit } from '../../../src/domain/entity/service/merge.service.js';
import type { Entity, EntityMetadata } from '../../../src/domain/entity/model/entity.js';
import type { EntityAttributes } from '../../../src/domain/entity/model/attributes.js';
import { computeIdentitySignature } from '../../../src/domain/entity/model/identity-signature.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';

function makeWineEntity(
  label: string,
  producerId: string = 'prod-1',
  regionId: string = 'region-1',
  attributes: EntityAttributes = {},
  relations: Entity['relations'] = {},
): Entity {
  const sig = computeIdentitySignature('wine', {
    canonicalLabel: label,
    producerId,
    regionId,
  });
  const now = new Date();
  const metadata: EntityMetadata = { createdAt: now, updatedAt: now };
  return {
    id: createEntityId(),
    type: 'wine',
    canonicalLabel: label,
    identitySignature: sig,
    relations: { producedBy: producerId as any, locatedIn: regionId as any, ...relations },
    attributes,
    metadata,
  };
}

function makeProducerEntity(label: string): Entity {
  const sig = computeIdentitySignature('producer', { canonicalLabel: label });
  const now = new Date();
  return {
    id: createEntityId(),
    type: 'producer',
    canonicalLabel: label,
    identitySignature: sig,
    relations: {},
    attributes: {},
    metadata: { createdAt: now, updatedAt: now },
  };
}

function makeGrapeEntity(label: string): Entity {
  const sig = computeIdentitySignature('grape', { canonicalLabel: label });
  const now = new Date();
  return {
    id: createEntityId(),
    type: 'grape',
    canonicalLabel: label,
    identitySignature: sig,
    relations: {},
    attributes: {},
    metadata: { createdAt: now, updatedAt: now },
  };
}

function makeVintageEntity(
  label: string,
  wineId: string,
  vintageYear: number,
  parentWineId: string,
): Entity {
  const sig = computeIdentitySignature('vintage', { canonicalLabel: label, wineId, vintageYear });
  const now = new Date();
  return {
    id: createEntityId(),
    type: 'vintage',
    canonicalLabel: label,
    identitySignature: sig,
    relations: { variantOf: parentWineId as any },
    attributes: { vintage: vintageYear },
    metadata: { createdAt: now, updatedAt: now },
  };
}

describe('canMerge', () => {
  describe('same type entities', () => {
    it('same type + same signature → canMerge=true', () => {
      const a = makeWineEntity('Opus One', 'prod-1', 'region-1');
      const b = makeWineEntity('Opus One', 'prod-1', 'region-1'); // same sig
      const result = canMerge(a, b);
      expect(result.allowed).toBe(true);
    });
  });

  describe('different type entities', () => {
    it('wine vs producer → canMerge=false', () => {
      const wine = makeWineEntity('Opus One');
      const producer = makeProducerEntity('Opus One');
      const result = canMerge(wine, producer);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Type mismatch');
    });
  });

  describe('vintage conflict', () => {
    it('two vintage entities with different vintageYear → canMerge=false', () => {
      const v2018 = makeVintageEntity('Opus One 2018', 'wine-opus', 2018, 'wine-opus');
      const v2019 = makeVintageEntity('Opus One 2019', 'wine-opus', 2019, 'wine-opus');
      // Different signatures → also blocked by signature check
      const result = canMerge(v2018, v2019);
      expect(result.allowed).toBe(false);
    });

    it('two vintage entities with same vintageYear + same wineId → canMerge=true', () => {
      const v2018a = makeVintageEntity('Opus One 2018', 'wine-opus', 2018, 'wine-opus');
      const v2018b = makeVintageEntity('Opus One 2018', 'wine-opus', 2018, 'wine-opus');
      const result = canMerge(v2018a, v2018b);
      expect(result.allowed).toBe(true);
    });
  });

  describe('relation conflicts', () => {
    it('different producedBy → canMerge=false', () => {
      const a = makeWineEntity('Grand Vin', 'prod-A', 'region-1');
      // Same canonical label + region but different producerId → different signature anyway
      // To test relation conflict: same sig but different relations would require manual setup
      // Let's test the actual logic: same sig, conflicting producedBy
      const sig = computeIdentitySignature('wine', {
        canonicalLabel: 'Grand Vin',
        producerId: 'prod-A',
        regionId: 'region-1',
      });
      const aWithSig: Entity = {
        ...a,
        identitySignature: sig,
        relations: { producedBy: 'prod-A' as any, locatedIn: 'region-1' as any },
      };
      const bWithConflict: Entity = {
        ...makeWineEntity('Grand Vin', 'prod-B', 'region-1'),
        identitySignature: sig, // same sig (force for test)
        relations: { producedBy: 'prod-B' as any, locatedIn: 'region-1' as any },
      };
      const result = canMerge(aWithSig, bWithConflict);
      expect(result.allowed).toBe(false);
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts!.some((c) => c.includes('producedBy'))).toBe(true);
    });
  });
});

describe('merge', () => {
  it('merge() returns entity with combined attributes', () => {
    const a = makeWineEntity('Opus One', 'prod-1', 'region-1', { style: 'red', body: 0.8 });
    const b = makeWineEntity('Opus One', 'prod-1', 'region-1', { sweetness: 0.1, acidity: 0.6 });

    const merged = merge(a, b, 'test merge');
    expect(merged.attributes.style).toBe('red');
    expect(merged.attributes.body).toBe(0.8);
    expect(merged.attributes.sweetness).toBe(0.1);
    expect(merged.attributes.acidity).toBe(0.6);
  });

  it('merge() preserves survivor entity id', () => {
    const a = makeWineEntity('Opus One', 'prod-1', 'region-1');
    const b = makeWineEntity('Opus One', 'prod-1', 'region-1');

    const merged = merge(a, b, 'test merge');
    expect(merged.id).toBe(a.id);
  });

  it('merge() throws when merge is not allowed', () => {
    const wine = makeWineEntity('Opus One');
    const producer = makeProducerEntity('Opus One');
    expect(() => merge(wine, producer, 'invalid merge')).toThrow('Merge not allowed');
  });

  it('merge() uses earlier createdAt', () => {
    const earlyDate = new Date('2020-01-01');
    const lateDate = new Date('2021-01-01');
    const a = makeWineEntity('Opus One', 'prod-1', 'region-1');
    const b = makeWineEntity('Opus One', 'prod-1', 'region-1');

    const aWithDate: Entity = { ...a, metadata: { ...a.metadata, createdAt: earlyDate } };
    const bWithDate: Entity = { ...b, metadata: { ...b.metadata, createdAt: lateDate } };

    const merged = merge(aWithDate, bWithDate, 'merge test');
    expect(merged.metadata.createdAt).toEqual(earlyDate);
  });

  it('merge() combines grape arrays without duplicates', () => {
    const a = makeWineEntity('Blend', 'prod-1', 'region-1', { grapes: ['Cabernet Sauvignon'] });
    const b = makeWineEntity('Blend', 'prod-1', 'region-1', { grapes: ['Cabernet Sauvignon', 'Merlot'] });

    const merged = merge(a, b, 'merge test');
    expect(merged.attributes.grapes).toBeDefined();
    expect(merged.attributes.grapes!).toContain('Cabernet Sauvignon');
    expect(merged.attributes.grapes!).toContain('Merlot');
    // No duplicates
    const cab = merged.attributes.grapes!.filter((g) => g === 'Cabernet Sauvignon');
    expect(cab).toHaveLength(1);
  });

  it('merge() deduplicates 3+ grapes when both arrays share common elements', () => {
    // a has 2 grapes, b has 3 — with 2 overlapping; merged should have exactly 3 unique grapes
    const a = makeWineEntity('Blend', 'prod-1', 'region-1', {
      grapes: ['Cabernet Sauvignon', 'Merlot'],
    });
    const b = makeWineEntity('Blend', 'prod-1', 'region-1', {
      grapes: ['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc'],
    });

    const merged = merge(a, b, 'merge test');
    expect(merged.attributes.grapes).toBeDefined();
    // All three varieties present
    expect(merged.attributes.grapes!).toContain('Cabernet Sauvignon');
    expect(merged.attributes.grapes!).toContain('Merlot');
    expect(merged.attributes.grapes!).toContain('Cabernet Franc');
    // Exactly 3 unique grapes — no duplicates from either array
    expect(merged.attributes.grapes!).toHaveLength(3);
  });
});

describe('canSplit', () => {
  it('grape entity → canSplit=false (grapes are atomic)', () => {
    const grape = makeGrapeEntity('Cabernet Sauvignon');
    expect(canSplit(grape, 'splitting reason')).toBe(false);
  });

  it('wine entity with reason → canSplit=true', () => {
    const wine = makeWineEntity('Opus One');
    expect(canSplit(wine, 'legitimate reason for split')).toBe(true);
  });

  it('producer entity → canSplit=true', () => {
    const producer = makeProducerEntity('Opus Winery');
    expect(canSplit(producer, 'producer split reason')).toBe(true);
  });

  it('empty reason → canSplit=false', () => {
    const wine = makeWineEntity('Opus One');
    expect(canSplit(wine, '')).toBe(false);
    expect(canSplit(wine, '   ')).toBe(false);
  });
});
