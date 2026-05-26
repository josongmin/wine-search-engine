/**
 * Wine domain ontology for deterministic claim verification (RFC-020).
 *
 * Provides region hierarchy, grape alias resolution, and wine type
 * normalization. All data is static — zero LLM calls.
 *
 * Module-scope Maps per CLAUDE.md rule 16 (deterministic collections at module scope).
 */
/**
 * Maps a sub-region to its parent region(s).
 * Used for hierarchy_match: "Pauillac" claim matches "Bordeaux" evidence.
 *
 * Coverage: top ~120 wine regions. Unknown regions return empty array.
 */
export declare const REGION_PARENTS: ReadonlyMap<string, readonly string[]>;
/**
 * Check if `child` region is a sub-region of `parent` (hierarchy match).
 * Both inputs are lowercased + NFKC-normalized + accent-folded before lookup.
 *
 * Returns the depth: 0 = exact match, 1 = direct parent, 2+ = ancestor.
 * Returns -1 if no hierarchy relationship found.
 */
export declare function regionHierarchyDepth(child: string, parent: string): number;
/**
 * Check if two regions are related (either direction) in the hierarchy.
 */
export declare function regionsRelated(a: string, b: string): boolean;
/**
 * RFC-019: Ontology traversal — returns the ancestor chain (parents) of a region
 * from closest to furthest. Empty array if the region is unknown or a root.
 *
 * Example: `regionAncestors('pauillac')` →
 *   `['haut-médoc', 'médoc', 'bordeaux', 'france']`
 *
 * Used by OntologyExpansion to derive inferred constraints:
 *   `region=Pauillac` → inferred `country=France`, soft `region∈[Bordeaux]`
 */
export declare function regionAncestors(region: string): readonly string[];
/**
 * Maps grape synonyms to canonical names.
 * Used for normalized_match: "Shiraz" claim matches "Syrah" evidence.
 */
export declare const GRAPE_ALIASES: ReadonlyMap<string, string>;
/**
 * Resolve a grape name to its canonical form.
 * Returns the canonical name, or the original (lowercased NFKC) if not found.
 */
export declare function resolveGrapeAlias(grape: string): string;
/**
 * Check if two grape names are synonyms of the same canonical variety.
 */
export declare function grapesEquivalent(a: string, b: string): boolean;
/**
 * Canonical wine types.
 *
 * Fortified/aromatized expansion (2026-05, S3): Korean and English aliases for
 * Port (포트와인/포트), Sherry (셰리/쉐리), Vermouth (베르무트/베르뭇), Madeira
 * (마데이라), Marsala (마살라). All map to the canonical `fortified`
 * wine-type so the entity resolver routes them through the wine-domain
 * pipeline (preventing the OOD-alcohol redirect and avoiding the
 * unsupported-intent reject path documented in S3).
 *
 * Note: 토카이 (Tokaji) is intentionally NOT registered here because the gold
 * catalog already maps it to the higher-precision appellation
 * "Royal Tokaji Aszú 6 Puttonyos 2017" (verified by
 * gold-korean-entity-alias-catalog.regression.test.ts). Adding 토카이 here
 * would shadow that appellation mapping.
 */
export declare const WINE_TYPE_ALIASES: ReadonlyMap<string, string>;
/**
 * Normalize a wine type string to canonical form.
 * Returns canonical type or the original (lowercased) if not found.
 */
export declare function normalizeWineType(wineType: string): string;
/**
 * Parse a Korean price expression to KRW number.
 * Handles: "5만원", "50,000원", "$50", "€40"
 * Returns null if unparseable.
 */
export declare function parseKoreanPrice(text: string): number | null;
//# sourceMappingURL=wine-ontology.d.ts.map