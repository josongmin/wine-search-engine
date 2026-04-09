import { describe, it, expect } from 'vitest';
import { buildSeedKGFromSnapshot, loadSeedKG } from '../load-seed-kg.js';

function baseSnapshot(): Record<string, unknown> {
  return {
    version: 'test-1.0',
    entities: {
      'country:france': {
        id: 'country:france',
        type: 'country',
        canonical: 'France',
        parent: null,
        hierarchy: [],
        aliases: ['France', '프랑스'],
      },
      'region:bordeaux': {
        id: 'region:bordeaux',
        type: 'region',
        canonical: 'Bordeaux',
        parent: 'France',
        hierarchy: ['France'],
        aliases: ['Bordeaux'],
      },
      'appellation:pauillac': {
        id: 'appellation:pauillac',
        type: 'appellation',
        canonical: 'Pauillac',
        parent: 'Bordeaux',
        hierarchy: ['Bordeaux', 'France'],
        aliases: ['Pauillac'],
      },
      'grape_primary:syrah': {
        id: 'grape_primary:syrah',
        type: 'grape_primary',
        canonical: 'Syrah',
        parent: null,
        hierarchy: [],
        aliases: ['Syrah', 'Shiraz'],
      },
      'wine_type:red': {
        id: 'wine_type:red',
        type: 'wine_type',
        canonical: 'red',
        parent: null,
        hierarchy: [],
        aliases: ['red', '레드'],
      },
    },
    regionHierarchy: {
      Pauillac: 'Bordeaux',
      Bordeaux: 'France',
    },
  };
}

describe('buildSeedKGFromSnapshot', () => {
  it('loads nodes and part_of edges from a fixture snapshot', () => {
    const kg = buildSeedKGFromSnapshot(baseSnapshot());
    expect(kg.version).toBe('test-1.0');
    expect(kg.nodes.size).toBe(5);
    // Hierarchy edge from entity parent.
    const pauillacEdges = kg.edges.filter((e) => e.from === 'appellation:pauillac');
    expect(pauillacEdges).toHaveLength(1);
    expect(pauillacEdges[0]).toMatchObject({
      from: 'appellation:pauillac',
      to: 'region:bordeaux',
      type: 'part_of',
    });
    const bordeauxEdges = kg.edges.filter((e) => e.from === 'region:bordeaux');
    expect(bordeauxEdges).toHaveLength(1);
    expect(bordeauxEdges[0]?.to).toBe('country:france');
  });

  it('maps grape_primary entity type to the grape node type', () => {
    const kg = buildSeedKGFromSnapshot(baseSnapshot());
    const syrah = kg.nodes.get('grape_primary:syrah');
    expect(syrah?.type).toBe('grape');
    expect(syrah?.canonical).toBe('Syrah');
    // Aliases preserved.
    expect(syrah?.aliases).toContain('Shiraz');
  });

  it('throws on entity missing a required canonical field', () => {
    const bad = {
      version: 't',
      entities: {
        'country:france': {
          id: 'country:france',
          type: 'country',
          // canonical missing
          aliases: [],
        },
      },
    };
    expect(() => buildSeedKGFromSnapshot(bad)).toThrow(/invalid ontology snapshot/);
  });

  it('drops orphan edges from regionHierarchy that reference unknown labels', () => {
    const snap = baseSnapshot();
    (snap['regionHierarchy'] as Record<string, string>)['Pauillac'] = 'Ghost Region';
    const kg = buildSeedKGFromSnapshot(snap);
    // Orphan edge dropped; no edge from pauillac to a ghost node.
    expect(
      kg.edges.find((e) => e.from === 'appellation:pauillac' && e.type === 'part_of' && e.to !== 'region:bordeaux'),
    ).toBeUndefined();
  });

  it('detects cycles in the part_of graph and throws with the path', () => {
    const cyclic = {
      version: 't',
      entities: {
        'region:a': {
          id: 'region:a',
          type: 'region',
          canonical: 'A',
          hierarchy: ['B'],
          aliases: [],
        },
        'region:b': {
          id: 'region:b',
          type: 'region',
          canonical: 'B',
          hierarchy: ['C'],
          aliases: [],
        },
        'region:c': {
          id: 'region:c',
          type: 'region',
          canonical: 'C',
          hierarchy: ['A'],
          aliases: [],
        },
      },
    };
    expect(() => buildSeedKGFromSnapshot(cyclic)).toThrow(/cycle detected/);
  });

  it('returns an empty KG for an empty entities map without throwing', () => {
    const kg = buildSeedKGFromSnapshot({ version: 'v0', entities: {} });
    expect(kg.nodes.size).toBe(0);
    expect(kg.edges).toHaveLength(0);
    expect(kg.version).toBe('v0');
  });

  it('loadSeedKG materializes the real data/entity-ontology.json snapshot', async () => {
    const kg = await loadSeedKG();
    expect(kg.nodes.size).toBeGreaterThan(100);
    expect(kg.edges.length).toBeGreaterThan(0);
    // Real snapshot has France as a country and Bordeaux as a region.
    const france = Array.from(kg.nodes.values()).find(
      (n) => n.canonical.toLowerCase() === 'france',
    );
    expect(france?.type).toBe('country');
  });
});
