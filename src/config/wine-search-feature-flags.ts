/**
 * Wine-search feature flags — single source of truth (SSoT) for env-driven
 * feature gates that span multiple modules.
 *
 * CLAUDE.md rule 30 (cross-module constant SSoT): when a flag drives behaviour
 * in `container.ts` AND in a use-case module, both MUST import the same constant
 * from here. Two independent `process.env[...]` reads will silently drift the
 * day someone tightens one side and forgets the other.
 *
 * Reads occur at module load — toggling requires a process restart. This matches
 * the rest of the wine-search bootstrap which captures env exactly once for
 * deterministic startup.
 */

/**
 * Multi-Query Rewrite + HyDE pre-retrieval fan-out.
 *
 * Wave 2: DEFAULT ON. Only an explicit `WINE_SEARCH_MULTI_QUERY_ENABLED=false`
 * opt-out disables the fan-out. Any other value (unset / `'true'` / typo) is
 * treated as ENABLED so misconfiguration does not silently regress recall.
 *
 * Consumers:
 *   - `src/config/container.ts` — gates `MultiQueryGenerator` / `HydeGenerator`
 *     construction (zero-cost when off; the generators are not instantiated).
 *   - `src/application/search/search-usecase-hybrid-candidates.ts` — gates the
 *     runtime fan-out check inside the retrieval pipeline.
 */
export const MULTI_QUERY_FEATURE_FLAG_ENABLED: boolean =
  process.env['WINE_SEARCH_MULTI_QUERY_ENABLED'] !== 'false';
