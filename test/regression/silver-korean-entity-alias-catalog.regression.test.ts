import { describe, expect, it } from 'vitest';

import { loadSilverStructuredKoreanAliasSourceRows } from '../../scripts/lib/structured-korean-alias-source.js';
import { SILVER_KOREAN_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/generated/silver-korean-entity-alias-catalog.js';

const WHITESPACE_RE = /\s+/gu;

interface ExpectedSilverAliasEntry {
  readonly surface: string;
  readonly mappedAttribute: 'appellation';
  readonly canonicalValue: string;
  readonly mappingConfidence: number;
  readonly provenance: 'silver_catalog';
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

async function buildExpectedSilverAliasCatalog(): Promise<readonly ExpectedSilverAliasEntry[]> {
  const rows = await loadSilverStructuredKoreanAliasSourceRows();
  const owners = new Map<string, AliasOwner[]>();

  for (const row of rows) {
    const canonicalValue = row.canonicalLabel.trim();
    if (canonicalValue.length === 0) {
      continue;
    }

    for (const alias of row.koreanAliases) {
      const normalized = normalizeSurface(alias);
      const existing = owners.get(normalized) ?? [];
      existing.push({
        surface: alias,
        canonicalValue,
        entityId: row.entityId,
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
        mappingConfidence: 0.93,
        provenance: 'silver_catalog' as const,
        resolutionMode: 'direct' as const,
        exportToDefaultMappings: false as const,
      };
    })
    .filter((entry): entry is ExpectedSilverAliasEntry => entry !== null)
    .sort((left, right) => {
      const byCanonical = left.canonicalValue.localeCompare(right.canonicalValue, 'en');
      if (byCanonical !== 0) {
        return byCanonical;
      }
      return left.surface.localeCompare(right.surface, 'ko');
    });
}

describe('silver Korean entity alias catalog regression', () => {
  it('stays in sync with structured silver identity-safe Hangul aliases', async () => {
    await expect(buildExpectedSilverAliasCatalog()).resolves.toEqual(
      SILVER_KOREAN_ENTITY_ALIAS_CATALOG,
    );
  });

  it('contains only direct exact aliases that never export to default mappings', () => {
    for (const entry of SILVER_KOREAN_ENTITY_ALIAS_CATALOG) {
      expect(entry.mappedAttribute).toBe('appellation');
      expect(entry.resolutionMode).toBe('direct');
      expect(entry.provenance).toBe('silver_catalog');
      expect(entry.exportToDefaultMappings).toBe(false);
    }
  });
});
