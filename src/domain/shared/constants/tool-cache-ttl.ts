/**
 * Tool Result Cache — per-tool TTL SSoT.
 *
 * Drives `ToolResultCachePort.set(..., ttlSeconds)` for the PtE wine-agent-loop's
 * memoization layer. Each TTL is justified against the volatility of the
 * underlying corpus / projection that the tool's downstream pipeline reads.
 *
 * CLAUDE.md rule 15: every numeric magic carries a named const + comment.
 * CLAUDE.md rule 30: cross-module constants live in a single shared module.
 *
 * Units: seconds, matching `Redis SET EX <seconds>`.
 *
 * Composite-project note: `src/domain/shared/**` is the leaf — it MUST NOT
 * import outside itself (see `tsconfig.json` solution layout). The tool-name
 * keys below are STRING LITERALS, intentionally NOT typed via
 * `KnownAgentToolName` (which lives in `src/domain/agent/`). A regression
 * test in `test/regression/tool-result-cache.regression.test.ts` asserts
 * 1:1 parity with `KNOWN_AGENT_TOOL_NAMES`.
 */

import { SECONDS_PER_MINUTE, MINUTES_PER_HOUR, HOURS_PER_DAY } from '../utils/time-units.js';

const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

// ---------------------------------------------------------------------------
// Per-tool TTL horizons (named for auditability)
// ---------------------------------------------------------------------------

/** lookup_wine — entity identity → canonical resolution.
 *  The PG alias overlay + entity ETL refresh on a daily cadence at best
 *  (canonical labels essentially never change). 1 day TTL is the tightest
 *  bound that still captures the same-day re-issued query pattern (bench
 *  reruns, user retries). */
const LOOKUP_WINE_TTL_DAYS = 1;

/** search_wines — constraint-driven retrieval.
 *  Results depend on Vespa snapshot + LTR weights + recent ingest. Vespa
 *  publish cadence is hourly at the slowest; 1 hour is the freshest TTL
 *  that still lets repeat queries within a session benefit from cache. */
const SEARCH_WINES_TTL_HOURS = 1;

/** compare_wines — entity-pair → comparison projection.
 *  Volatility tracks lookup_wine (the pair resolves to two identities,
 *  then comparison is a deterministic projection). 1 day matches. */
const COMPARE_WINES_TTL_DAYS = 1;

/** check_drinking_window — deterministic from (entity vintage, style,
 *  predictor model version). Predictor model version changes ≪ daily;
 *  vintage is immutable. 1 day TTL is well within the safe envelope. */
const CHECK_DRINKING_WINDOW_TTL_DAYS = 1;

/** get_food_pairings — deterministic from (food, style preferences).
 *  Pairing taxonomy + style affinity tables refresh on a multi-day cadence.
 *  1 day TTL captures the common pattern: a user asks twice in a session. */
const GET_FOOD_PAIRINGS_TTL_DAYS = 1;

// ---------------------------------------------------------------------------
// Public SSoT: per-tool TTL map
// ---------------------------------------------------------------------------

/**
 * Per-tool TTL (in seconds) for `ToolResultCachePort.set`. Keys are the
 * canonical agent tool names; parity with `KNOWN_AGENT_TOOL_NAMES` is
 * enforced by a regression test (composite-leaf restriction prevents a
 * direct import from `src/domain/agent/`).
 *
 * A tool MUST be listed here to be cached; the helper falls back to
 * "do not cache" on lookup miss so adding a new tool without an explicit
 * TTL never silently caches with an arbitrary default.
 */
export const TOOL_RESULT_CACHE_TTL_SECONDS: ReadonlyMap<string, number> = new Map<string, number>([
  ['lookup_wine', LOOKUP_WINE_TTL_DAYS * SECONDS_PER_DAY],
  ['search_wines', SEARCH_WINES_TTL_HOURS * SECONDS_PER_HOUR],
  ['compare_wines', COMPARE_WINES_TTL_DAYS * SECONDS_PER_DAY],
  ['check_drinking_window', CHECK_DRINKING_WINDOW_TTL_DAYS * SECONDS_PER_DAY],
  ['get_food_pairings', GET_FOOD_PAIRINGS_TTL_DAYS * SECONDS_PER_DAY],
]);

/**
 * Resolve the TTL for a tool name; returns `undefined` for unknown tools
 * (the cache helper treats `undefined` as "do not cache"). Always prefer
 * this helper over a bare `.get()` so the not-cached fallback is explicit
 * at the call site.
 */
export function toolResultCacheTtlSeconds(toolName: string): number | undefined {
  return TOOL_RESULT_CACHE_TTL_SECONDS.get(toolName);
}
