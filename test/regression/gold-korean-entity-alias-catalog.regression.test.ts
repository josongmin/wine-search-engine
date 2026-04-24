import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CURATED_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/entity-alias-catalog.js';
import { GOLD_KOREAN_ENTITY_ALIAS_CATALOG } from '../../src/domain/attribute/service/generated/gold-korean-entity-alias-catalog.js';
import { listDefaultEntityAliasMappings } from '../../src/domain/attribute/service/nl-mapper.js';
import {
  GRAPE_ALIASES,
  REGION_PARENTS,
  WINE_TYPE_ALIASES,
} from '../../src/domain/evaluation/service/wine-ontology.js';

const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;
const WHITESPACE_RE = /\s+/gu;
const GOLD_MAPPING_CONFIDENCE = 0.95;
const GOLD_CATALOG_PATH = path.resolve(process.cwd(), 'data', 'gold-wine-catalog.jsonl');

interface GoldCatalogRow {
  readonly entityId: string;
  readonly canonicalLabel: string;
  readonly koreanAliases?: readonly string[] | undefined;
}

interface ExpectedGoldAliasEntry {
  readonly surface: string;
  readonly mappedAttribute: 'appellation';
  readonly canonicalValue: string;
  readonly mappingConfidence: number;
  readonly provenance: 'gold_catalog';
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

function buildClaimedSurfaceSet(): ReadonlySet<string> {
  const claimed = new Set<string>();

  for (const alias of CURATED_ENTITY_ALIAS_CATALOG) {
    if (alias.provenance === 'gold_catalog') {
      continue;
    }
    claimed.add(normalizeSurface(alias.surface));
  }

  for (const [surface] of WINE_TYPE_ALIASES) {
    claimed.add(normalizeSurface(surface));
  }

  const discoveredCountries = new Set<string>();
  for (const parents of REGION_PARENTS.values()) {
    if (parents.length === 0) {
      continue;
    }
    const last = parents[parents.length - 1];
    if (last !== undefined) {
      discoveredCountries.add(last);
    }
  }

  for (const country of discoveredCountries) {
    claimed.add(normalizeSurface(country));
  }

  for (const regionKey of REGION_PARENTS.keys()) {
    claimed.add(normalizeSurface(regionKey));
  }

  for (const [surface] of GRAPE_ALIASES) {
    claimed.add(normalizeSurface(surface));
  }

  for (const mapping of listDefaultEntityAliasMappings()) {
    claimed.add(normalizeSurface(mapping.phrase));
  }

  return claimed;
}

async function loadGoldCatalog(): Promise<readonly GoldCatalogRow[]> {
  const raw = await fs.readFile(GOLD_CATALOG_PATH, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as GoldCatalogRow);
}

async function buildExpectedGoldAliasCatalog(): Promise<readonly ExpectedGoldAliasEntry[]> {
  const rows = await loadGoldCatalog();
  const claimedSurfaces = buildClaimedSurfaceSet();
  const owners = new Map<string, AliasOwner[]>();

  for (const row of rows) {
    const canonicalValue = row.canonicalLabel.trim();
    if (canonicalValue.length === 0) {
      continue;
    }

    for (const rawAlias of row.koreanAliases ?? []) {
      if (!HANGUL_RE.test(rawAlias)) {
        continue;
      }

      const surface = rawAlias.trim();
      if (surface.length === 0) {
        continue;
      }

      const normalized = normalizeSurface(surface);
      if (claimedSurfaces.has(normalized)) {
        continue;
      }

      const existing = owners.get(normalized) ?? [];
      existing.push({
        surface,
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
        mappingConfidence: GOLD_MAPPING_CONFIDENCE,
        provenance: 'gold_catalog' as const,
        resolutionMode: 'direct' as const,
        exportToDefaultMappings: false as const,
      };
    })
    .filter((entry): entry is ExpectedGoldAliasEntry => entry !== null)
    .sort((left, right) => {
      const byCanonical = left.canonicalValue.localeCompare(right.canonicalValue, 'en');
      if (byCanonical !== 0) {
        return byCanonical;
      }
      return left.surface.localeCompare(right.surface, 'ko');
    });
}

describe('gold Korean entity alias catalog regression', () => {
  it('stays in sync with the gold wine catalog Hangul aliases after authority-claim filtering', async () => {
    await expect(buildExpectedGoldAliasCatalog()).resolves.toEqual(GOLD_KOREAN_ENTITY_ALIAS_CATALOG);
  });

  it('contains only Hangul-bearing direct exact aliases that never export to default mappings', () => {
    expect(GOLD_KOREAN_ENTITY_ALIAS_CATALOG.length).toBeGreaterThan(100);
    for (const entry of GOLD_KOREAN_ENTITY_ALIAS_CATALOG) {
      expect(HANGUL_RE.test(entry.surface)).toBe(true);
      expect(entry.mappedAttribute).toBe('appellation');
      expect(entry.resolutionMode).toBe('direct');
      expect(entry.provenance).toBe('gold_catalog');
      expect(entry.exportToDefaultMappings).toBe(false);
    }
  });
});
