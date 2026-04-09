/**
 * RFC-019/020 regression: canonical value consistency across modules.
 *
 * Verifies that country names, entity types, and canonical forms stay in
 * sync across the multiple modules that independently reference them.
 * Append-only — never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import { resolveEntity } from '../../src/domain/attribute/service/entity-resolver.js';
import { CURATED_ENTITY_ALIASES } from '../../src/domain/attribute/service/entity-alias-registry.js';
import { REGION_PARENTS } from '../../src/domain/evaluation/service/wine-ontology.js';
import { wineTitleCase } from '../../src/domain/shared/utils/title-case.js';

describe('RFC-019/020 regression: canonical value consistency', () => {
  // ── Country canonical values must match across modules ──

  it('entity-alias-registry Korean country aliases resolve to matching canonical values', () => {
    const countryAliases = CURATED_ENTITY_ALIASES.filter(
      (a) => a.entityType === 'country',
    );
    expect(countryAliases.length).toBeGreaterThan(0);

    for (const alias of countryAliases) {
      const resolved = resolveEntity(alias.surface);
      expect(resolved).not.toBeNull();
      // Canonical value from curated alias and entity-resolver must agree
      // (case-insensitive because resolver titleCase normalizes)
      expect(resolved!.canonicalValue.toLowerCase()).toBe(
        alias.canonicalValue.toLowerCase(),
      );
    }
  });

  it('REGION_PARENTS country values match entity-resolver via wineTitleCase', () => {
    // Countries = last element of each REGION_PARENTS parent chain
    const countries = new Set<string>();
    for (const parents of REGION_PARENTS.values()) {
      if (parents.length > 0) {
        countries.add(parents[parents.length - 1]!);
      }
    }
    expect(countries.size).toBeGreaterThan(0);

    for (const raw of countries) {
      const canonical = wineTitleCase(raw);
      const resolved = resolveEntity(raw.toLowerCase());
      expect(resolved).not.toBeNull();
      expect(resolved!.canonicalValue).toBe(canonical);
      expect(resolved!.entityType).toBe('country');
    }
  });

  it('no module uses "USA" as a canonical country value (must be "United States")', () => {
    // entity-alias-registry
    const usaAliases = CURATED_ENTITY_ALIASES.filter(
      (a) => a.canonicalValue === 'USA',
    );
    expect(usaAliases).toHaveLength(0);

    // entity-resolver
    const resolvedUsa = resolveEntity('usa');
    if (resolvedUsa !== null) {
      expect(resolvedUsa.canonicalValue).not.toBe('USA');
      expect(resolvedUsa.canonicalValue).toBe('United States');
    }

    // Korean alias for USA
    const resolvedKr = resolveEntity('미국');
    expect(resolvedKr).not.toBeNull();
    expect(resolvedKr!.canonicalValue).toBe('United States');
  });

  // ── titleCase preposition consistency ──

  it('wineTitleCase preserves lowercase Romance prepositions', () => {
    expect(wineTitleCase('brunello di montalcino')).toBe('Brunello di Montalcino');
    expect(wineTitleCase('côtes du rhône')).toBe('Côtes du Rhône');
    expect(wineTitleCase('ribera del duero')).toBe('Ribera del Duero');
    expect(wineTitleCase('côte de nuits')).toBe('Côte de Nuits');
    expect(wineTitleCase('côte de beaune')).toBe('Côte de Beaune');
  });

  it('wineTitleCase capitalises first word even if it is a preposition', () => {
    // Edge case: "de" at position 0 should still be capitalised
    expect(wineTitleCase('de la region')).toBe('De la Region');
  });
});
