import type { EntityType } from './entity-resolver.js';
import type { AmbiguousEntityHintSpec } from '../model/ambiguous-entity-hint.js';
import { type EntityAliasProvenance, type EntityResolutionMode } from './entity-alias-catalog.js';
interface CuratedAlias {
    readonly surface: string;
    readonly canonicalValue: string;
    readonly entityType: EntityType;
    readonly confidence: number;
    readonly provenance: EntityAliasProvenance;
    readonly resolutionMode: EntityResolutionMode;
    readonly ambiguityHint?: AmbiguousEntityHintSpec | undefined;
}
export declare const CURATED_ENTITY_ALIASES: readonly CuratedAlias[];
export {};
//# sourceMappingURL=entity-alias-registry.d.ts.map