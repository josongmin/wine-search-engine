/**
 * Cache TTL SSoT (E1: infra.redis-cache-layer maturity 3 → 4).
 *
 * Formal per-cache TTL contract. Replaces ad-hoc magic numbers in callers
 * with named constants whose rationale is documented inline.
 *
 * **Why a shared module?** Rule 30 — domain constants used in 2+ files must
 * live in a single source of truth. Previously embedding/phrase/query caches
 * each accepted an inline TTL from their callers (e.g. `cache.set(..., 7200)`),
 * making TTL drift undetectable across surfaces.
 *
 * **Why no `.max(N)` bound here?** Per-cache clamps (e.g. `redis-phrase-cache`
 * `PHRASE_CACHE_MAX_TTL_SECONDS`) handle the upper-bound safety. This module
 * defines *defaults*; callers may still pass an explicit TTL when a domain
 * fact justifies it (e.g. negative-cache short TTL for empty LLM constraint
 * results in `llm-nl-mapper.ts`).
 *
 * Rule 15: every numeric constant carries a comment explaining the value.
 */

import {
  SECONDS_PER_MINUTE,
  MINUTES_PER_HOUR,
  HOURS_PER_DAY,
} from '../../domain/shared/utils/time-units.js';

const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const SECONDS_PER_DAY = SECONDS_PER_HOUR * HOURS_PER_DAY;

/**
 * Per-kind TTL horizon constants. Each value is a domain-justified count of
 * the base unit it is multiplied by (days, minutes). Extracting them keeps
 * the scaling arithmetic auditable without leaking magic numbers.
 */
const EMBEDDING_TTL_DAYS = 7; // OpenAI embeddings stable per model version
const PHRASE_TTL_DAYS = 1; // formalises llm-nl-mapper.PHRASE_CACHE_TTL_SECONDS (24h)
const QUERY_TTL_MINUTES = 5; // freshness vs. repeat-query hit rate tradeoff

/**
 * Default TTL (in seconds) per cache kind.
 *
 * EMBEDDING — 7 days. OpenAI `text-embedding-3-small` vectors are stable
 *   per model version; only model upgrades invalidate them. Long TTL maximises
 *   hit rate on repeat queries with minor surface variations.
 * PHRASE    — 1 day. LLM constraint extraction over user phrases. Alias drift
 *   is slow but possible (catalog refresh, new producer aliases). 24h matches
 *   the existing `llm-nl-mapper.PHRASE_CACHE_TTL_SECONDS` value, formalised here.
 * QUERY     — 5 minutes. Full search-response cache. Short TTL balances
 *   freshness (new ingest, ranker tweaks) against repeat-query hit rate.
 */
export const CACHE_TTL_SECONDS = {
  EMBEDDING: EMBEDDING_TTL_DAYS * SECONDS_PER_DAY,
  PHRASE: PHRASE_TTL_DAYS * SECONDS_PER_DAY,
  QUERY: QUERY_TTL_MINUTES * SECONDS_PER_MINUTE,
} as const;

type CacheKind = keyof typeof CACHE_TTL_SECONDS;

/**
 * Returns the documented default TTL for a given cache kind.
 * Callers that need an override (e.g. negative-cache short TTL) may still
 * pass an explicit `ttlSeconds` to the cache's `set()` method.
 */
export function defaultTtlSecondsFor(kind: CacheKind): number {
  return CACHE_TTL_SECONDS[kind];
}
