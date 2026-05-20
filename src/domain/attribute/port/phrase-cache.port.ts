/**
 * Hexagonal port for phrase-level LLM constraint caching.
 *
 * Used by {@link LlmNLMapper} to memoize per-phrase LLM constraint extraction
 * results so that common phrases (and common no-match phrases via negative
 * cache entries) skip the LLM call entirely.
 *
 * Implementations are responsible for serialization, TTL handling, and
 * fail-safe behavior. The consumer treats every error as a cache miss.
 */

import type { LlmConstraintItem } from '../model/llm-constraint-schema.js';

export interface PhraseCachePort {
  /**
   * Look up cached LLM constraint items for a phrase.
   * @returns the cached items (possibly empty for negative cache entries),
   *          or `null` for cache miss / lookup failure.
   */
  get(phrase: string): Promise<LlmConstraintItem[] | null>;

  /**
   * Store LLM constraint items for a phrase. Empty arrays are valid and
   * represent negative cache entries (the LLM returned no constraints).
   * Failures must not throw — implementations should swallow and log.
   *
   * `ttlSeconds` is optional; when omitted, implementations should fall back
   * to `CACHE_TTL_SECONDS.PHRASE` from the cache-ttl-config SSoT (E1).
   */
  set(phrase: string, items: LlmConstraintItem[], ttlSeconds?: number): Promise<void>;
}
