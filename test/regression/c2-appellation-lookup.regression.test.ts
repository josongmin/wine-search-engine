import { describe, it, expect } from 'vitest';
import { resolveEntity, isDirectEntityResolution } from '../../src/domain/attribute/service/entity-resolver.js';
import { ConstraintCompiler } from '../../src/domain/query/service/constraint-compiler.js';
import { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../src/domain/attribute/port/mapping-table.port.js';
import { QueryNormalizer } from '../../src/domain/query/service/query-normalizer.js';

/**
 * C2 regression — bare-appellation queries must:
 *  1. Resolve deterministically through the catalog to type='appellation'
 *     with the canonical English value. ([[project-entity-route-broken]] —
 *     hybrid path relies on the catalog because the alias overlay does not
 *     always have a row for every appellation surface.)
 *  2. Compile to a hard `appellation=<Canonical>` constraint via NLMapper
 *     defaults so downstream sparse filters and retrieval expansions can
 *     attach a canonical English value to the lexical/semantic query
 *     variants.
 *  3. The compiled appellation value (canonical English) is what the
 *     hybrid retriever expands into the lexical seed pool — without this,
 *     a bare Korean appellation query like "바롤로" never produces an
 *     English-token surface for Vespa BM25.
 *
 * The contract pinned here is the analyzer/planner side of the C2 fix:
 * downstream Vespa data quality (appellation field population) is a
 * separate concern, but anything that regresses this contract WILL
 * regress C2.
 */

const nullPort: MappingTablePort = {
  findMapping: async () => null,
  findMappingsByAttribute: async () => [],
  getCurrentVersion: async () => 'v1.0',
};

const mapper = new NLMapper(nullPort);
const compiler = new ConstraintCompiler(mapper);
const normalizer = new QueryNormalizer();

describe('C2 regression: bare-appellation lookup contract', () => {
  describe('catalog resolution — resolveEntity returns appellation type with canonical English', () => {
    it.each([
      ['바롤로', 'appellation', 'Barolo'],
      ['barolo', 'appellation', 'Barolo'],
      ['pauillac', 'appellation', 'Pauillac'],
      ['Pauillac', 'appellation', 'Pauillac'],
      ['브루넬로', 'appellation', 'Brunello di Montalcino'],
      ['chianti', 'appellation', 'Chianti'],
      ['margaux', 'appellation', 'Margaux'],
    ])('resolveEntity(%s) → %s=%s', (surface, expectedType, expectedCanonical) => {
      const resolved = resolveEntity(surface, { preferEntityOverStyle: true });
      expect(resolved).not.toBeNull();
      expect(resolved!.entityType).toBe(expectedType);
      expect(resolved!.canonicalValue).toBe(expectedCanonical);
      expect(isDirectEntityResolution(resolved)).toBe(true);
    });
  });

  describe('planner constraint emission — bare appellation surfaces compile to hard appellation constraint', () => {
    it.each([
      ['바롤로', 'Barolo'],
      ['Pauillac', 'Pauillac'],
      ['barolo', 'Barolo'],
      ['브루넬로', 'Brunello di Montalcino'],
    ])('"%s" → bundle.hard contains appellation=%s', async (query, expectedValue) => {
      const views = normalizer.normalize(query);
      const result = await compiler.compile(views.strict);

      const appellationConstraint = result.bundle.hard.find(
        (constraint) => constraint.attribute === 'appellation',
      );
      expect(appellationConstraint, `expected hard appellation constraint for "${query}"`).toBeDefined();
      expect(appellationConstraint!.operator).toBe('=');
      expect(appellationConstraint!.value).toBe(expectedValue);
    });

    it('"바롤로 와인" (multi-token) still extracts appellation=Barolo as the strongest signal', async () => {
      const views = normalizer.normalize('바롤로 와인');
      const result = await compiler.compile(views.strict);
      const appellationConstraint = result.bundle.hard.find(
        (constraint) => constraint.attribute === 'appellation',
      );
      expect(appellationConstraint).toBeDefined();
      expect(appellationConstraint!.value).toBe('Barolo');
    });
  });

  describe('compositional inference — appellation hard constraint produces region/country/grape soft inferences', () => {
    it('"바롤로" yields inferred region=Piedmont, country=Italy, grape=Nebbiolo', async () => {
      const views = normalizer.normalize('바롤로');
      const result = await compiler.compile(views.strict);

      const inferredAttributes = result.bundle.inferred.map((constraint) => constraint.attribute);
      // Compositional inference (Barolo → Piedmont / Italy / Nebbiolo) is the
      // recall safety net when Vespa data is sparse on the `appellation` field.
      // Without these soft signals, a bare-appellation query has no fallback.
      expect(inferredAttributes).toContain('region');
      expect(inferredAttributes).toContain('country');
      // grape inference is supplied by compositional-inference.ts (Barolo → Nebbiolo).
      expect(inferredAttributes).toContain('grape_primary');

      const country = result.bundle.inferred.find((c) => c.attribute === 'country');
      expect(country?.value).toBe('Italy');
    });

    it('"Pauillac" yields inferred country=France and at least one Bordeaux-chain region', async () => {
      const views = normalizer.normalize('Pauillac');
      const result = await compiler.compile(views.strict);

      const country = result.bundle.inferred.find((c) => c.attribute === 'country');
      expect(country).toBeDefined();
      expect(country!.value).toBe('France');

      const regions = result.bundle.inferred
        .filter((c) => c.attribute === 'region')
        .map((c) => c.value);
      // REGION_PARENTS chain for Pauillac includes haut-médoc, médoc, bordeaux.
      // Title-cased canonical forms come out of compositional-inference.
      expect(regions.length).toBeGreaterThan(0);
      expect(regions.some((value) => typeof value === 'string' && /bordeaux/i.test(value)))
        .toBe(true);
    });
  });
});
