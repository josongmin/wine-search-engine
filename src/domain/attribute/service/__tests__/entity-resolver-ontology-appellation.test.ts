import { describe, expect, it } from 'vitest';

import { resolveEntity } from '../entity-resolver.js';

describe('entity resolver ontology appellation surfaces', () => {
  it('resolves brunello di montalcino as an appellation instead of a broad region', () => {
    const resolved = resolveEntity('brunello di montalcino', { preferEntityOverStyle: true });

    expect(resolved).toMatchObject({
      canonicalValue: 'Brunello di Montalcino',
      entityType: 'appellation',
      provenance: 'region_parents',
      resolutionMode: 'direct',
    });
  });
});
