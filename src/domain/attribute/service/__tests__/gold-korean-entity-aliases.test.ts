import { describe, expect, it } from 'vitest';

import { GOLD_KOREAN_ENTITY_ALIAS_CATALOG } from '../generated/gold-korean-entity-alias-catalog.js';
import { resolveEntity } from '../entity-resolver.js';

describe('gold Korean entity aliases', () => {
  it('resolves Chateau Ausone Korean aliases through the generated gold catalog', () => {
    const resolved = resolveEntity('오존');

    expect(resolved).toMatchObject({
      canonicalValue: 'Château Ausone 2016',
      entityType: 'appellation',
      provenance: 'gold_catalog',
      resolutionMode: 'direct',
    });
  });

  it('resolves Salon Korean aliases through the generated gold catalog', () => {
    const resolved = resolveEntity('살롱');

    expect(resolved).toMatchObject({
      canonicalValue: 'Salon Blanc de Blancs 2012',
      entityType: 'appellation',
      provenance: 'gold_catalog',
      resolutionMode: 'direct',
    });
  });

  it('resolves Bollinger Special Cuvee Korean aliases through the generated gold catalog', () => {
    const resolved = resolveEntity('볼랭저 스페셜 뀌베');

    expect(resolved).toMatchObject({
      canonicalValue: 'Bollinger Special Cuvée Brut NV',
      entityType: 'appellation',
      provenance: 'gold_catalog',
      resolutionMode: 'direct',
    });
  });

  it('does not override broad curated authority surfaces already claimed by the resolver', () => {
    const blockedSurfaces = new Set(GOLD_KOREAN_ENTITY_ALIAS_CATALOG.map((entry) => entry.surface));

    expect(blockedSurfaces.has('오푸스 원')).toBe(false);
    expect(blockedSurfaces.has('샤또 마고')).toBe(false);
    expect(blockedSurfaces.has('바롤로')).toBe(false);
  });
});
