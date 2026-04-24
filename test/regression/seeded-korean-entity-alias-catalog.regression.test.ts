import { describe, expect, it } from 'vitest';

import { WINES } from '../../scripts/seed-wines-real.js';
import { SEEDED_KOREAN_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/generated/seeded-korean-entity-alias-catalog.js';

const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;
const WHITESPACE_RE = /\s+/gu;
const SEEDED_MAPPING_CONFIDENCE = 0.94;

interface ExpectedSeededAliasEntry {
  readonly surface: string;
  readonly mappedAttribute: 'appellation';
  readonly canonicalValue: string;
  readonly mappingConfidence: number;
  readonly provenance: 'seed_catalog';
  readonly resolutionMode: 'direct';
  readonly exportToDefaultMappings: false;
}

interface AliasOwner {
  readonly surface: string;
  readonly canonicalValue: string;
  readonly entityId: string;
}

function normalizeSurface(surface: string): string {
  return surface.normalize('NFKC').toLowerCase().replace(WHITESPACE_RE, ' ').trim();
}

function buildExpectedSeededAliasCatalog(): readonly ExpectedSeededAliasEntry[] {
  const owners = new Map<string, AliasOwner[]>();

  for (const wine of WINES) {
    const canonicalValue = wine.canonicalLabel.trim();
    if (canonicalValue.length === 0) {
      continue;
    }

    for (const alias of wine.aliasesIdentitySafe ?? []) {
      if (!HANGUL_RE.test(alias)) {
        continue;
      }

      const surface = alias.trim();
      if (surface.length === 0) {
        continue;
      }

      const normalized = normalizeSurface(surface);
      const existing = owners.get(normalized) ?? [];
      existing.push({
        surface,
        canonicalValue,
        entityId: String(wine.entityId),
      });
      owners.set(normalized, existing);
    }
  }

  return [...owners.values()]
    .map((aliasOwners) => {
      const entityIds = [...new Set(aliasOwners.map((entry) => entry.entityId))];
      if (entityIds.length !== 1) {
        return null;
      }
      const selected = aliasOwners[0];
      if (selected === undefined) {
        return null;
      }
      return {
        surface: selected.surface,
        mappedAttribute: 'appellation' as const,
        canonicalValue: selected.canonicalValue,
        mappingConfidence: SEEDED_MAPPING_CONFIDENCE,
        provenance: 'seed_catalog' as const,
        resolutionMode: 'direct' as const,
        exportToDefaultMappings: false as const,
      };
    })
    .filter((entry): entry is ExpectedSeededAliasEntry => entry !== null)
    .sort((left, right) => {
      const byCanonical = left.canonicalValue.localeCompare(right.canonicalValue, 'en');
      if (byCanonical !== 0) {
        return byCanonical;
      }
      return left.surface.localeCompare(right.surface, 'ko');
    });
}

describe('seeded Korean entity alias catalog regression', () => {
  it('stays in sync with the seed wine identity-safe Hangul aliases', () => {
    expect(SEEDED_KOREAN_ENTITY_ALIAS_CATALOG).toEqual(buildExpectedSeededAliasCatalog());
  });

  it('contains only Hangul-bearing direct exact aliases that never export to default mappings', () => {
    expect(SEEDED_KOREAN_ENTITY_ALIAS_CATALOG.length).toBeGreaterThan(100);
    for (const entry of SEEDED_KOREAN_ENTITY_ALIAS_CATALOG) {
      expect(HANGUL_RE.test(entry.surface)).toBe(true);
      expect(entry.mappedAttribute).toBe('appellation');
      expect(entry.resolutionMode).toBe('direct');
      expect(entry.provenance).toBe('seed_catalog');
      expect(entry.exportToDefaultMappings).toBe(false);
    }
  });
});
