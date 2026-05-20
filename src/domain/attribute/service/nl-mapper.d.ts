import type { NormalizedConstraint } from '../../shared/types/index.js';
import type { ConstraintExtractionTrace } from '../model/constraint-extraction-trace.js';
import type { NLMapping } from '../model/nl-mapping.js';
import type { MappingTablePort } from '../port/mapping-table.port.js';
import { type ResolverCompatibleAttribute } from './entity-alias-catalog.js';
interface DefaultEntityAliasMapping {
    readonly phrase: string;
    readonly mappedAttribute: ResolverCompatibleAttribute;
    readonly canonicalValue: string;
    readonly mappingConfidence: number;
}
/**
 * Returns resolver-compatible entity aliases sourced from DEFAULT_MAPPINGS.
 *
 * This keeps NL mapper phrase coverage and Entity Resolver coverage in sync so
 * new entity aliases are not accidentally added to one layer only.
 */
export declare function listDefaultEntityAliasMappings(): readonly DefaultEntityAliasMapping[];
/**
 * Converts an {@link NLMapping} to a {@link NormalizedConstraint}.
 */
export declare function toNormalizedConstraint(mapping: NLMapping): NormalizedConstraint;
/** Result of {@link NLMapper.mapConstraints} — constraints plus optional extraction provenance. */
export interface MapConstraintsResult {
    readonly constraints: NormalizedConstraint[];
    /** Request-scoped extraction provenance (observability / QueryPlanV2.constraintExtraction shape). */
    readonly constraintExtraction?: ConstraintExtractionTrace | undefined;
}
/** Optional controls for {@link NLMapper.mapConstraints} (cancellation, future flags). */
export interface MapConstraintsOptions {
    readonly abortSignal?: AbortSignal | undefined;
}
/**
 * Maps natural-language phrases to structured attribute constraints.
 * Implements RFC-004 §4.
 *
 * All mappings are deterministic. Same input + same version = same output.
 * Falls back to built-in default mappings when the repository has no match.
 */
export declare class NLMapper {
    private readonly mappingTable;
    constructor(mappingTable: MappingTablePort);
    /**
     * Maps a single natural-language phrase to a structured NLMapping.
     *
     * Resolution order:
     * 1. Query the mapping table repository.
     * 2. Fall back to built-in default mappings.
     *
     * @param phrase - The natural-language phrase (e.g. "묵직한").
     * @returns The mapping, or `null` if no mapping exists.
     */
    mapPhrase(phrase: string): Promise<NLMapping | null>;
    /**
     * Maps multiple natural-language phrases to normalized constraints.
     * Phrases that do not match any mapping are silently skipped.
     *
     * @param phrases - Array of natural-language phrases.
     * @param options - Optional cancellation — when {@link MapConstraintsOptions.abortSignal}
     *   aborts, throws an `AbortError`-named {@link Error} (checked before each phrase).
     * @returns Constraints and a rule-table extraction trace (no LLM fields).
     */
    mapConstraints(phrases: readonly string[], options?: MapConstraintsOptions): Promise<MapConstraintsResult>;
}
export {};
//# sourceMappingURL=nl-mapper.d.ts.map