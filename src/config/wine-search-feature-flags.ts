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

/**
 * One-shot LLM fallback for comparison_nested queries that exhaust the
 * mini-loop's step budget.
 *
 * Bench v9 found 4 comparison_nested scenarios in the bottom 15 that all
 * terminated with `terminationReason: 'max_steps'` because the multi-step
 * compare→rank→drinkability→synthesize plan ran out of LLM turns before
 * producing a verdict. When this flag is on (default), the orchestrator
 * detects the stall, pulls the candidates the mini-loop already retrieved,
 * and runs a single grounded synthesis call to emit a verdict — trading
 * exploratory drilling for full-context one-shot reasoning.
 *
 * DEFAULT ON. Only an explicit `WINE_SEARCH_COMPARISON_LLM_FALLBACK_ENABLED=false`
 * opt-out disables it. Any other value (unset / `'true'` / typo) is treated
 * as ENABLED so a misconfiguration does not silently regress the bench.
 *
 * Consumers:
 *   - `src/config/container.ts` — gates `ComparisonLlmFallback` wiring
 *     into the orchestrator.
 *   - `src/application/wine-search/wine-search-orchestrator.ts` — gates the
 *     runtime stall-detection check.
 */
export const COMPARISON_LLM_FALLBACK_FEATURE_FLAG_ENABLED: boolean =
  process.env['WINE_SEARCH_COMPARISON_LLM_FALLBACK_ENABLED'] !== 'false';
