import { describe, it, expect } from 'vitest';
import { KGOperations } from '../service/kg-operations.js';
import type { WineKG, WineKGNode, WineKGEdge } from '../model/wine-kg.js';

function buildTestKG(): WineKG {
  const nodes = new Map<string, WineKGNode>();
  nodes.set('country:france', { id: 'country:france', type: 'country', canonical: 'France', aliases: ['프랑스'] });
  nodes.set('region:bordeaux', { id: 'region:bordeaux', type: 'region', canonical: 'Bordeaux', aliases: ['보르도'] });
  nodes.set('region:burgundy', { id: 'region:burgundy', type: 'region', canonical: 'Burgundy', aliases: ['부르고뉴'] });
  nodes.set('region:champagne', { id: 'region:champagne', type: 'region', canonical: 'Champagne', aliases: ['샴페인'] });
  nodes.set('sub_region:pauillac', { id: 'sub_region:pauillac', type: 'sub_region', canonical: 'Pauillac', aliases: [] });
  nodes.set('grape:cabernet_sauvignon', { id: 'grape:cabernet_sauvignon', type: 'grape', canonical: 'Cabernet Sauvignon', aliases: [] });
  nodes.set('wine_type:red', { id: 'wine_type:red', type: 'wine_type', canonical: 'Red', aliases: ['레드'] });
  const edges: WineKGEdge[] = [
    { from: 'sub_region:pauillac', to: 'region:bordeaux', type: 'part_of' },
    { from: 'region:bordeaux', to: 'country:france', type: 'part_of' },
    { from: 'region:burgundy', to: 'country:france', type: 'part_of' },
    { from: 'region:champagne', to: 'country:france', type: 'part_of' },
  ];
  return { version: 'test-1.0', nodes, edges };
}

describe('KGOperations', () => {
  const kg = buildTestKG();
  const ops = new KGOperations(kg);

  it('getNode returns existing node', () => {
    expect(ops.getNode('region:bordeaux')?.canonical).toBe('Bordeaux');
  });

  it('getNode returns undefined for missing', () => {
    expect(ops.getNode('region:nope')).toBeUndefined();
  });

  it('resolveAlias finds by canonical', () => {
    expect(ops.resolveAlias('Bordeaux')?.id).toBe('region:bordeaux');
  });

  it('resolveAlias finds by Korean alias', () => {
    expect(ops.resolveAlias('보르도')?.id).toBe('region:bordeaux');
  });

  it('resolveAlias is case-insensitive', () => {
    expect(ops.resolveAlias('BORDEAUX')?.id).toBe('region:bordeaux');
  });

  it('neighbors via part_of returns parents', () => {
    const n = ops.neighbors('region:bordeaux', 'part_of');
    expect(n.map((x) => x.id)).toContain('country:france');
  });

  it('traverse with depth=2 finds grandparent', () => {
    const r = ops.traverse('sub_region:pauillac', 2, ['part_of']);
    const ids = r.map((x) => x.node.id);
    expect(ids).toContain('region:bordeaux');
    expect(ids).toContain('country:france');
  });

  it('ancestors traverses is_a/part_of chain', () => {
    const a = ops.ancestors('sub_region:pauillac');
    expect(a.map((x) => x.id)).toContain('country:france');
  });

  it('inferCompositional emits Champagne → sparkling + France', () => {
    const inf = ops.inferCompositional(['region:champagne']);
    const attrs = inf.map((i) => i.attribute);
    expect(attrs).toContain('wine_type');
    expect(attrs).toContain('country');
  });

  it('inferCompositional emits Bordeaux+red → grape_family', () => {
    const inf = ops.inferCompositional(['region:bordeaux', 'wine_type:red']);
    const found = inf.find((i) => i.attribute === 'grape_family');
    expect(found?.value).toContain('Cabernet');
  });
});
