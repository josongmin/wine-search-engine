/**
 * All recognized query intent labels as defined in RFC-005 section 3.2.
 *
 * - `entity_exact` -- the user asks for a specific, identifiable wine entity.
 * - `entity_fuzzy` -- the user asks for an entity by an imprecise or partial name.
 * - `facet_search` -- the user filters by structured facets (region, grape, etc.).
 * - `semantic_discovery` -- the user describes a preference in natural language.
 * - `pairing_search` -- the user asks for wine paired with a food or occasion.
 * - `budget_search` -- the user constrains primarily by price.
 * - `comparison_search` -- the user compares two or more named entities.
 * - `mixed_query` -- the query contains both an entity anchor and constraints.
 */
export declare const QUERY_INTENTS: readonly ["entity_exact", "entity_fuzzy", "facet_search", "semantic_discovery", "pairing_search", "budget_search", "comparison_search", "mixed_query"];
/** A single recognized query intent. */
export type QueryIntent = (typeof QUERY_INTENTS)[number];
//# sourceMappingURL=query-intent.d.ts.map