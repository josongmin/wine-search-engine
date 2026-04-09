import { describe, expect, it } from 'vitest';
import {
  buildOntologySnapshot,
  ONTOLOGY_SNAPSHOT_VERSION,
} from '../service/ontology-snapshot.js';

describe('buildOntologySnapshot', () => {
  it('builds a deterministic ontology snapshot with region and grape nodes', () => {
    const snapshot = buildOntologySnapshot('2026-04-09T00:00:00.000Z');

    expect(snapshot.version).toBe(ONTOLOGY_SNAPSHOT_VERSION);
    expect(snapshot.generatedAt).toBe('2026-04-09T00:00:00.000Z');
    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'region:bordeaux',
          entityType: 'region',
          canonicalLabel: 'Bordeaux',
        }),
        expect.objectContaining({
          id: 'grape_primary:syrah',
          entityType: 'grape_primary',
        }),
        expect.objectContaining({
          id: 'wine_type:sparkling',
          entityType: 'wine_type',
        }),
      ]),
    );
  });

  it('includes RFC-019 P3 entities keyed map', () => {
    const snapshot = buildOntologySnapshot('2026-04-09T00:00:00.000Z');

    const bordeaux = snapshot.entities['region:bordeaux'];
    expect(bordeaux).toBeDefined();
    expect(bordeaux!.id).toBe('region:bordeaux');
    expect(bordeaux!.type).toBe('region');
    expect(bordeaux!.canonical).toBe('Bordeaux');
    expect(bordeaux!.parent).toBe('France');
    expect(bordeaux!.hierarchy).toEqual(['France']);
    // Should include Korean alias from CURATED_ENTITY_ALIASES
    expect(bordeaux!.aliases).toEqual(expect.arrayContaining(['보르도']));
  });

  it('includes regionHierarchy flat map', () => {
    const snapshot = buildOntologySnapshot('2026-04-09T00:00:00.000Z');

    expect(snapshot.regionHierarchy['Pauillac']).toBe('Haut-médoc');
    expect(snapshot.regionHierarchy['Bordeaux']).toBe('France');
  });

  it('includes grapeAliases map', () => {
    const snapshot = buildOntologySnapshot('2026-04-09T00:00:00.000Z');

    expect(snapshot.grapeAliases['shiraz']).toBe('syrah');
    expect(snapshot.grapeAliases['primitivo']).toBe('zinfandel');
  });

  it('includes wineTypeAliases map', () => {
    const snapshot = buildOntologySnapshot('2026-04-09T00:00:00.000Z');

    expect(snapshot.wineTypeAliases['레드']).toBe('red');
    expect(snapshot.wineTypeAliases['rosé']).toBe('rosé');
  });

  it('entities include curated Korean aliases from CURATED_ENTITY_ALIASES', () => {
    const snapshot = buildOntologySnapshot('2026-04-09T00:00:00.000Z');

    // Napa Valley should have Korean alias
    const napa = snapshot.entities['region:napa valley'];
    expect(napa).toBeDefined();
    expect(napa!.aliases).toEqual(expect.arrayContaining(['나파', '나파 밸리']));
  });

  it('country entities have no parent', () => {
    const snapshot = buildOntologySnapshot('2026-04-09T00:00:00.000Z');

    const france = snapshot.entities['country:france'];
    expect(france).toBeDefined();
    expect(france!.parent).toBeNull();
    expect(france!.hierarchy).toEqual([]);
  });
});
