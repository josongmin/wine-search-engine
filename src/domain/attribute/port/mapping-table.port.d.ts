import type { NLMapping } from '../model/nl-mapping.js';
/**
 * Port for accessing the natural-language to attribute mapping table.
 * Implementations may be backed by a database, file, or in-memory store.
 */
export interface MappingTablePort {
    /**
     * Finds a mapping for the given phrase.
     * Optionally scoped to a specific mapping table version.
     *
     * @param phrase - The natural-language phrase to look up.
     * @param version - Optional version filter. If omitted, uses current version.
     * @returns The mapping, or `null` if no mapping exists for this phrase.
     */
    findMapping(phrase: string, version?: string): Promise<NLMapping | null>;
    /**
     * Finds all mappings that target a given attribute.
     * Useful for reverse-lookup (e.g. "what phrases map to body?").
     *
     * @param attribute - The attribute name (e.g. "body", "sweetness").
     * @returns All mappings targeting this attribute.
     */
    findMappingsByAttribute(attribute: string): Promise<readonly NLMapping[]>;
    /**
     * Returns the current (latest) version identifier of the mapping table.
     *
     * @returns The version string (e.g. "v1.0").
     */
    getCurrentVersion(): Promise<string>;
}
//# sourceMappingURL=mapping-table.port.d.ts.map