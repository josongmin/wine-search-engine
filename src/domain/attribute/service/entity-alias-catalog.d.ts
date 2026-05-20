import type { AmbiguousEntityHintSpec } from '../model/ambiguous-entity-hint.js';
export type ResolverCompatibleAttribute = 'wine_type' | 'country' | 'region' | 'appellation' | 'grape_primary';
export type EntityAliasProvenance = 'country_derived' | 'region_parents' | 'grape_aliases' | 'gold_catalog' | 'seed_catalog' | 'silver_catalog';
export type EntityResolutionMode = 'direct' | 'context_required';
export interface CuratedEntityAliasCatalogEntry {
    readonly surface: string;
    readonly mappedAttribute: ResolverCompatibleAttribute;
    readonly canonicalValue: string;
    readonly mappingConfidence: number;
    readonly provenance: EntityAliasProvenance;
    readonly resolutionMode: EntityResolutionMode;
    readonly exportToDefaultMappings: boolean;
    readonly ambiguityHint?: AmbiguousEntityHintSpec | undefined;
}
export declare const CURATED_ENTITY_ALIAS_CATALOG: readonly CuratedEntityAliasCatalogEntry[];
//# sourceMappingURL=entity-alias-catalog.d.ts.map