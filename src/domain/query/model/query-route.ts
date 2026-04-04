/**
 * All recognized query routing targets as defined in RFC-005 section 3.3.
 *
 * - `entity` -- the query resolves exclusively via entity/alias lookup.
 * - `hybrid` -- the query uses both entity lookup and vector/constraint search.
 * - `mixed` -- the query requires multiple search strategies in parallel.
 */
export const QUERY_ROUTES = ['entity', 'hybrid', 'mixed'] as const;

/** The routing target for a query plan. */
export type QueryRoute = (typeof QUERY_ROUTES)[number];
