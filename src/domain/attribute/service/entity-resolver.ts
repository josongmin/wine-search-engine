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
import { listDefaultEntityAliasMappings } from './nl-mapper.js';
import { CURATED_ENTITY_ALIASES } from './entity-alias-registry.js';
import type { FuzzyMatcherPort } from '../../query/port/fuzzy-matcher.port.js';
import { wineTitleCase } from '../../shared/utils/title-case.js';

export type EntityType =
  | 'wine_type'
  | 'country'
  | 'region'
  | 'appellation'
  | 'grape_primary';

// ── Confidence tiers for auto-derived entries (Rule 15: named constants) ──
// Higher = less ambiguous source. Curated aliases (entity-alias-registry.ts)
// use their own per-entry confidence; these are for the auto-populated index.
/** Wine type aliases are categorical & unambiguous (red, white, sparkling). */
const CONFIDENCE_WINE_TYPE = 0.95;
/** Countries derived from REGION_PARENTS chain terminus — high confidence. */
const CONFIDENCE_COUNTRY_DERIVED = 0.92;
/** Region keys from REGION_PARENTS — slightly lower (sub-region ambiguity). */
const CONFIDENCE_REGION = 0.9;
/** Grape aliases — lowest auto tier (short names can be ambiguous). */
const CONFIDENCE_GRAPE = 0.88;

/** Minimum combinedScore from FuzzyMatcher to consider a fuzzy fallback hit. */
const FUZZY_MIN_CONFIDENCE = 0.7;
/** Discount applied to fuzzy matches relative to exact matches. */
const FUZZY_CONFIDENCE_DISCOUNT = 0.85;

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
  readonly provenance:
    | 'grape_aliases'
    | 'wine_type_aliases'
    | 'region_parents'
    | 'country_derived'
    | 'nl_mapper_defaults'
    | 'fuzzy_fallback';
}

const RESOLVER_VERSION = 'entity-resolver-v1.0';

type ResolverEntry = Omit<ResolvedEntity, 'matchedSurface'>;

export interface ResolveEntityOptions {
  /**
   * When true, prefer ontology-bearing entities (country/region/appellation/grape)
   * over style-like categories such as `wine_type`.
   */
  readonly preferEntityOverStyle?: boolean | undefined;
}

/**
 * Precomputed index: lowercase alias → ResolvedEntity (minus matchedSurface).
 *
 * Built once at module load. O(1) lookup thereafter. ~300 entries total.
 * Conflict policy: first-writer-wins within a single source; cross-source
 * priority = wine_type > country > appellation > region > grape
 * (more specific entity types take precedence to avoid "Pinot" being
 * classified as grape when a user wrote "pinot noir from burgundy").
 */
const RESOLVER_INDEX: ReadonlyMap<string, readonly ResolverEntry[]> = (() => {
  const map = new Map<string, ResolverEntry[]>();
  const register = (
    surface: string,
    resolved: ResolverEntry,
  ): void => {
    const key = normalizeResolverKey(surface);
    if (key.length === 0) return;
    const existing = map.get(key) ?? [];
    map.set(key, [...existing, resolved]);
  };

  // ── Wine types (highest priority: categorical, unambiguous) ──
  for (const [surface, canonical] of WINE_TYPE_ALIASES) {
    register(surface, {
      canonicalValue: canonical,
      entityType: 'wine_type',
      confidence: CONFIDENCE_WINE_TYPE,
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
      canonicalValue: wineTitleCase(country),
      entityType: 'country',
      confidence: CONFIDENCE_COUNTRY_DERIVED,
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
      canonicalValue: wineTitleCase(regionKey),
      entityType: 'region',
      confidence: CONFIDENCE_REGION,
      provenance: 'region_parents',
    });
  }

  // ── Grapes (lowest priority — singular words like "Pinot" could conflict
  // with region/type, so register last and only if the surface form isn't
  // already claimed by a more specific entity type) ──
  for (const [surface, canonical] of GRAPE_ALIASES) {
    register(surface, {
      canonicalValue: wineTitleCase(canonical),
      entityType: 'grape_primary',
      confidence: CONFIDENCE_GRAPE,
      provenance: 'grape_aliases',
    });
  }

  for (const alias of CURATED_ENTITY_ALIASES) {
    register(alias.surface, {
      canonicalValue: alias.canonicalValue,
      entityType: alias.entityType,
      confidence: alias.confidence,
      provenance: alias.provenance,
    });
  }

  // Keep resolver aliases structurally in sync with NL mapper defaults.
  // This prevents one-sided alias additions (DEFAULT_MAPPINGS updated, resolver stale).
  for (const mapping of listDefaultEntityAliasMappings()) {
    register(mapping.phrase, {
      canonicalValue: mapping.canonicalValue,
      entityType: toEntityType(mapping.mappedAttribute),
      confidence: mapping.mappingConfidence,
      provenance: 'nl_mapper_defaults',
    });
  }

  return map;
})();

const RESOLVER_COMPACT_INDEX: ReadonlyMap<string, readonly ResolverEntry[]> = (() => {
  const compactMap = new Map<string, ResolverEntry[]>();
  const registerCompact = (surface: string, resolved: ResolverEntry): void => {
    const compact = compactResolverKey(surface);
    if (compact.length === 0 || compact === surface) return;
    const existing = compactMap.get(compact) ?? [];
    compactMap.set(compact, [...existing, resolved]);
  };
  for (const [surface, entries] of RESOLVER_INDEX.entries()) {
    for (const entry of entries) {
      registerCompact(surface, entry);
    }
  }
  return compactMap;
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
  fuzzyMatcher?: FuzzyMatcherPort,
): ResolvedEntity | null {
  const key = normalizeResolverKey(spanText);
  if (key.length === 0) return null;
  const hits = RESOLVER_INDEX.get(key) ?? RESOLVER_COMPACT_INDEX.get(compactResolverKey(key));
  if (hits !== undefined && hits.length > 0) {
    const selected = [...hits].sort((left, right) => {
      const byType = entityPriority(right.entityType, options) - entityPriority(left.entityType, options);
      if (byType !== 0) return byType;
      return right.confidence - left.confidence;
    })[0];
    if (selected !== undefined) return { ...selected, matchedSurface: spanText };
  }

  // ── Fuzzy fallback: re-lookup best fuzzy match in RESOLVER_INDEX ──
  if (fuzzyMatcher !== undefined) {
    const MAX_FUZZY_EDIT_DISTANCE = 2;
    const fuzzyHits = fuzzyMatcher.match(spanText, MAX_FUZZY_EDIT_DISTANCE);
    for (const hit of fuzzyHits) {
      if (hit.combinedScore < FUZZY_MIN_CONFIDENCE) break; // sorted desc — no further hits will pass
      const fuzzyKey = normalizeResolverKey(hit.term);
      const resolved = RESOLVER_INDEX.get(fuzzyKey);
      if (resolved !== undefined && resolved.length > 0) {
        const selected = [...resolved].sort((left, right) => {
          const byType = entityPriority(right.entityType, options) - entityPriority(left.entityType, options);
          if (byType !== 0) return byType;
          return right.confidence - left.confidence;
        })[0];
        if (selected !== undefined) {
          return {
            ...selected,
            matchedSurface: spanText,
            confidence: hit.combinedScore * FUZZY_CONFIDENCE_DISCOUNT,
            provenance: 'fuzzy_fallback',
          };
        }
      }
    }
  }

  return null;
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


function normalizeResolverKey(surface: string): string {
  return surface
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function compactResolverKey(surface: string): string {
  return normalizeResolverKey(surface).replace(/\s+/g, '');
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

function toEntityType(attribute: string): EntityType {
  switch (attribute) {
    case 'wine_type':
      return 'wine_type';
    case 'country':
      return 'country';
    case 'region':
      return 'region';
    case 'appellation':
      return 'appellation';
    case 'grape_primary':
      return 'grape_primary';
    default: {
      throw new Error(`unsupported resolver attribute: ${attribute}`);
    }
  }
}
