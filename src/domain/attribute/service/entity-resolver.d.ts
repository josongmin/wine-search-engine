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
import type { EntityResolutionMode } from './entity-alias-catalog.js';
import type { AmbiguousEntityHint } from '../model/ambiguous-entity-hint.js';
import type { FuzzyMatcherPort } from '../../query/port/fuzzy-matcher.port.js';
export type EntityType = 'wine_type' | 'country' | 'region' | 'appellation' | 'grape_primary';
export interface ResolvedEntity {
    /** Resolved canonical display label (e.g. 'Bordeaux', 'Cabernet Sauvignon'). */
    readonly canonicalValue: string;
    /** Attribute category the entity belongs to. */
    readonly entityType: EntityType;
    /** Original span text that matched (for provenance). */
    readonly matchedSurface: string;
    /** Confidence derived from source table type. */
    readonly confidence: number;
    /** Whether this alias is safe to promote directly into planner constraints. */
    readonly resolutionMode: EntityResolutionMode;
    /** Retrieval/clarify hint for ambiguous short-form aliases. */
    readonly ambiguityHint?: AmbiguousEntityHint | undefined;
    /** Provenance tag — which source table provided this resolution. */
    readonly provenance: 'grape_aliases' | 'wine_type_aliases' | 'region_parents' | 'country_derived' | 'gold_catalog' | 'seed_catalog' | 'silver_catalog' | 'nl_mapper_defaults' | 'fuzzy_fallback';
}
interface ResolveEntityOptions {
    /**
     * When true, prefer ontology-bearing entities (country/region/appellation/grape)
     * over style-like categories such as `wine_type`.
     */
    readonly preferEntityOverStyle?: boolean | undefined;
}
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
export declare function resolveEntity(spanText: string, options?: ResolveEntityOptions, fuzzyMatcher?: FuzzyMatcherPort): ResolvedEntity | null;
export declare function isDirectEntityResolution(entity: ResolvedEntity | null | undefined): entity is ResolvedEntity;
export {};
//# sourceMappingURL=entity-resolver.d.ts.map