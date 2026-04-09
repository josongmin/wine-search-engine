/**
 * RFC-019 Stage 2: Entity Resolver Layer
 *
 * Unified canonical entity registry that consolidates all existing alias
 * tables into a single longest-match resolver. Replaces the scattered lookups
 * across:
 *   - `wine-ontology.ts`: GRAPE_ALIASES, WINE_TYPE_ALIASES, REGION_PARENTS
 *   - `nl-mapper.ts`: DEFAULT_MAPPINGS (wine_type/country/region/grape subset)
 *
 * Design contract (RFC-019 §6.2):
 *   - Input: a span text (already lowercase, NFKC normalized, punctuation-stripped)
 *   - Output: ResolvedEntity | null (null = not an entity span)
 *   - Deterministic: same text → same resolution (no LLM, no embedding)
 *   - Versioned: resolver produces `resolverVersion` for replay parity
 *   - Longest-match priority: "cabernet sauvignon" wins over "cabernet"
 *
 * This is the Tier 2 layer in RFC-019:
 *   Tier 1: DEFAULT_MAPPINGS exact match (already in NLMapper)
 *   Tier 2: EntityResolver (this file) — alias → canonical entity with type
 *   Tier 3: LLM linker (future — only for OOV)
 */

import {
  GRAPE_ALIASES,
  REGION_PARENTS,
  WINE_TYPE_ALIASES,
} from '../../evaluation/service/wine-ontology.js';

export type EntityType =
  | 'wine_type'
  | 'country'
  | 'region'
  | 'appellation'
  | 'grape_primary';

export interface ResolvedEntity {
  /** Resolved canonical display label (e.g. 'Bordeaux', 'Cabernet Sauvignon'). */
  readonly canonicalValue: string;
  /** Attribute category the entity belongs to. */
  readonly entityType: EntityType;
  /** Original span text that matched (for provenance). */
  readonly matchedSurface: string;
  /** Confidence derived from source table type. */
  readonly confidence: number;
  /** Provenance tag — which source table provided this resolution. */
  readonly provenance: 'grape_aliases' | 'wine_type_aliases' | 'region_parents' | 'country_derived';
}

const RESOLVER_VERSION = 'entity-resolver-v1.0';

export interface ResolveEntityOptions {
  /**
   * When true, prefer ontology-bearing entities (country/region/appellation/grape)
   * over style-like categories such as `wine_type`.
   */
  readonly preferEntityOverStyle?: boolean | undefined;
}

const CURATED_ENTITY_ALIASES: readonly {
  readonly surface: string;
  readonly canonicalValue: string;
  readonly entityType: EntityType;
  readonly confidence: number;
  readonly provenance: ResolvedEntity['provenance'];
}[] = [
  { surface: '프랑스', canonicalValue: 'France', entityType: 'country', confidence: 0.95, provenance: 'country_derived' },
  { surface: '이탈리아', canonicalValue: 'Italy', entityType: 'country', confidence: 0.95, provenance: 'country_derived' },
  { surface: '미국', canonicalValue: 'USA', entityType: 'country', confidence: 0.95, provenance: 'country_derived' },
  { surface: '칠레', canonicalValue: 'Chile', entityType: 'country', confidence: 0.95, provenance: 'country_derived' },
  { surface: '호주', canonicalValue: 'Australia', entityType: 'country', confidence: 0.95, provenance: 'country_derived' },
  { surface: '보르도', canonicalValue: 'Bordeaux', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '부르고뉴', canonicalValue: 'Burgundy', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '나파', canonicalValue: 'Napa Valley', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '나파 밸리', canonicalValue: 'Napa Valley', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '토스카나', canonicalValue: 'Tuscany', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '샴페인', canonicalValue: 'Champagne', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '모젤', canonicalValue: 'Mosel', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '리오하', canonicalValue: 'Rioja', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '멘도사', canonicalValue: 'Mendoza', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '말버러', canonicalValue: 'Marlborough', entityType: 'region', confidence: 0.95, provenance: 'region_parents' },
  { surface: '바롤로', canonicalValue: 'Barolo', entityType: 'appellation', confidence: 0.95, provenance: 'region_parents' },
  { surface: '브루넬로', canonicalValue: 'Brunello di Montalcino', entityType: 'appellation', confidence: 0.95, provenance: 'region_parents' },
  { surface: '카베르네', canonicalValue: 'Cabernet Sauvignon', entityType: 'grape_primary', confidence: 0.9, provenance: 'grape_aliases' },
  { surface: '메를로', canonicalValue: 'Merlot', entityType: 'grape_primary', confidence: 0.95, provenance: 'grape_aliases' },
  { surface: '피노', canonicalValue: 'Pinot Noir', entityType: 'grape_primary', confidence: 0.85, provenance: 'grape_aliases' },
  { surface: '샤르도네', canonicalValue: 'Chardonnay', entityType: 'grape_primary', confidence: 0.95, provenance: 'grape_aliases' },
] as const;

/**
 * Precomputed index: lowercase alias → ResolvedEntity (minus matchedSurface).
 *
 * Built once at module load. O(1) lookup thereafter. ~300 entries total.
 * Conflict policy: first-writer-wins within a single source; cross-source
 * priority = wine_type > country > appellation > region > grape
 * (more specific entity types take precedence to avoid "Pinot" being
 * classified as grape when a user wrote "pinot noir from burgundy").
 */
const RESOLVER_INDEX: ReadonlyMap<string, readonly Omit<ResolvedEntity, 'matchedSurface'>[]> = (() => {
  const map = new Map<string, Omit<ResolvedEntity, 'matchedSurface'>[]>();
  const register = (
    surface: string,
    resolved: Omit<ResolvedEntity, 'matchedSurface'>,
  ): void => {
    const existing = map.get(surface) ?? [];
    map.set(surface, [...existing, resolved]);
  };

  // ── Wine types (highest priority: categorical, unambiguous) ──
  for (const [surface, canonical] of WINE_TYPE_ALIASES) {
    register(surface, {
      canonicalValue: canonical,
      entityType: 'wine_type',
      confidence: 0.95,
      provenance: 'wine_type_aliases',
    });
  }

  // ── Countries (derived from region parent chains) ──
  // A country is any value that appears as the LAST element of a parent chain
  // in REGION_PARENTS. This keeps country/region consistent with the same SSOT.
  const discoveredCountries = new Set<string>();
  for (const parents of REGION_PARENTS.values()) {
    if (parents.length > 0) {
      discoveredCountries.add(parents[parents.length - 1]!);
    }
  }
  for (const country of discoveredCountries) {
    const lower = country.toLowerCase();
    register(lower, {
      canonicalValue: titleCase(country),
      entityType: 'country',
      confidence: 0.92,
      provenance: 'country_derived',
    });
  }

  // ── Regions (all keys of REGION_PARENTS that aren't countries) ──
  // We use REGION_PARENTS' key set as the canonical region list. Keys that
  // themselves appear in another parent chain as the last element are treated
  // as country-equivalent and skipped here to avoid clobbering.
  for (const regionKey of REGION_PARENTS.keys()) {
    const lower = regionKey.toLowerCase();
    if (discoveredCountries.has(lower)) continue;
    register(lower, {
      canonicalValue: titleCase(regionKey),
      entityType: 'region',
      confidence: 0.9,
      provenance: 'region_parents',
    });
  }

  // ── Grapes (lowest priority — singular words like "Pinot" could conflict
  // with region/type, so register last and only if the surface form isn't
  // already claimed by a more specific entity type) ──
  for (const [surface, canonical] of GRAPE_ALIASES) {
    register(surface, {
      canonicalValue: titleCase(canonical),
      entityType: 'grape_primary',
      confidence: 0.88,
      provenance: 'grape_aliases',
    });
  }

  for (const alias of CURATED_ENTITY_ALIASES) {
    register(alias.surface.toLowerCase(), {
      canonicalValue: alias.canonicalValue,
      entityType: alias.entityType,
      confidence: alias.confidence,
      provenance: alias.provenance,
    });
  }

  return map;
})();

/**
 * Resolve a span to a canonical entity.
 *
 * Input: span text (lowercase, NFKC normalized).
 * Output: ResolvedEntity on exact match, null otherwise.
 *
 * The caller (Planner.parseConstraints) is responsible for picking the
 * longest-matching span when multiple candidate spans overlap — see
 * span-parser.ts::resolveOverlaps.
 */
export function resolveEntity(
  spanText: string,
  options?: ResolveEntityOptions,
): ResolvedEntity | null {
  const key = spanText.trim().toLowerCase();
  if (key.length === 0) return null;
  const hits = RESOLVER_INDEX.get(key);
  if (hits === undefined || hits.length === 0) return null;
  const selected = [...hits].sort((left, right) =>
    entityPriority(right.entityType, options) - entityPriority(left.entityType, options))[0];
  if (selected === undefined) return null;
  return { ...selected, matchedSurface: spanText };
}

/** Version identifier embedded in traces for replay parity. */
export function resolverVersion(): string {
  return RESOLVER_VERSION;
}

/** Size of the entity index (for observability / health check). */
export function resolverEntryCount(): number {
  let count = 0;
  for (const entries of RESOLVER_INDEX.values()) {
    count += entries.length;
  }
  return count;
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

const PRIORITY_5 = 5;
const PRIORITY_4 = 4;
const PRIORITY_3 = 3;
const PRIORITY_2 = 2;
const PRIORITY_1 = 1;

function entityPriority(
  entityType: EntityType,
  options?: ResolveEntityOptions,
): number {
  if (options?.preferEntityOverStyle === true) {
    switch (entityType) {
      case 'country':
        return PRIORITY_5;
      case 'appellation':
        return PRIORITY_4;
      case 'region':
        return PRIORITY_3;
      case 'grape_primary':
        return PRIORITY_2;
      case 'wine_type':
        return PRIORITY_1;
    }
  }

  switch (entityType) {
    case 'wine_type':
      return PRIORITY_5;
    case 'country':
      return PRIORITY_4;
    case 'appellation':
      return PRIORITY_3;
    case 'region':
      return PRIORITY_2;
    case 'grape_primary':
      return PRIORITY_1;
  }
}
