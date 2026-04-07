/**
 * Cache key computation strategies for different layers of the search pipeline.
 *
 * All cache keys must be deterministic from inputs alone (no timestamps/randomness).
 * This ensures replay consistency and enables A/B testing with identical responses.
 */

import type { RetrievalMode } from '../../query/model/retrieval-mode.js';
import { createHash } from 'crypto';

/**
 * Query-level cache key: Identifies an entire search query + mode.
 *
 * Used for memoizing complete search responses within a time window.
 * Deterministic from query plan properties only.
 */
export interface QueryCacheKey {
  /** Canonical lowercase, whitespace-normalized query. */
  readonly normalizedQuery: string;

  /** Retrieval mode determines ranking profile (different cache buckets). */
  readonly retrievalMode: RetrievalMode;

  /** Hash of constraint tuples (hard constraints affect result set). */
  readonly constraintSignature: string;

  /** Hash of sorted expansion terms (semantic expansion affects retrieval). */
  readonly expansionHash: string;

  /** Session ID if applicable (session-scoped caching). */
  readonly sessionId?: string;

  /** Locale for context-aware result variation. */
  readonly locale?: string;

  /** Computed deterministic key for Redis storage. */
  readonly redisKey: string;
}

/**
 * Result-level cache key: Identifies ranked results post-retrieval.
 *
 * Used for memoizing ranked candidate sets (skips ranking recomputation).
 * Cacheable for stable retrieval modes (browse, attribute search).
 */
export interface ResultCacheKey {
  /** Retrieval profile identifier (sparse+dense balance). */
  readonly retrievalProfile: string;

  /** How many top results to cache. */
  readonly topNResults: number;

  /** Anchor entity if this is a similarity search. */
  readonly anchorEntityId?: string;

  /** Hash of applied filters (hard constraints). */
  readonly filterSignature: string;

  /** Retrieval mode (determines cacheability). */
  readonly retrievalMode: RetrievalMode;

  /** Computed deterministic key for Redis storage. */
  readonly redisKey: string;
}

/**
 * Embedding cache key: Identifies embeddings for specific query text.
 *
 * Used for memoizing dense embeddings (reuse for repeated query terms).
 * Very stable: embeddings only change on model upgrade.
 */
export interface EmbeddingCacheKey {
  /** Normalized text being embedded (lowercase, trimmed). */
  readonly text: string;

  /** Embedding model identifier (e.g., "bge-m3-wine-ft-v1"). */
  readonly modelId: string;

  /** Optional instruction prefix for structured embeddings. */
  readonly instructionPrefix?: string;

  /** Computed deterministic key for Redis storage. */
  readonly redisKey: string;
}

/**
 * Builder for deterministic query cache keys.
 *
 * Combines normalized query properties into a stable key suitable for deduplication.
 * All inputs must be from QueryPlanV1 (deterministic source).
 */
export class QueryCacheKeyBuilder {
  /**
   * Build a deterministic cache key for a query plan.
   *
   * @param normalizedQuery - Lowercased, whitespace-collapsed query from plan
   * @param retrievalMode - Mode determines ranking weights (different cache buckets)
   * @param constraintTuples - Array of [attribute, operator, value] constraint tuples
   * @param expansionTerms - Sorted array of expansion terms (lexical + semantic)
   * @param sessionId - Optional session context
   * @param locale - Optional locale hint
   * @returns Deterministic cache key
   */
  build(
    normalizedQuery: string,
    retrievalMode: RetrievalMode,
    constraintTuples: readonly (readonly [string, string, string])[],
    expansionTerms: readonly string[],
    sessionId?: string,
    locale?: string,
  ): QueryCacheKey {
    // Hash constraints deterministically (sorted tuples)
    const sortedConstraints = Array.from(constraintTuples)
      .sort(([a1, a2, a3], [b1, b2, b3]) =>
        a1.localeCompare(b1) || a2.localeCompare(b2) || a3.localeCompare(b3))
      .map((t) => t.join('|'))
      .join('||');
    const constraintSignature = hashDeterministic(sortedConstraints);

    // Hash expansions deterministically (sorted terms)
    const sortedExpansions = Array.from(expansionTerms).sort();
    const expansionHash = hashDeterministic(sortedExpansions.join('|'));

    // Combine components into deterministic Redis key
    const keyParts = [
      'query',
      retrievalMode,
      hashDeterministic(normalizedQuery),
      constraintSignature,
      expansionHash,
      locale ?? 'default',
    ];
    if (sessionId !== undefined) {
      keyParts.push(`session:${sessionId}`);
    }
    const redisKey = keyParts.join(':');

    return {
      normalizedQuery,
      retrievalMode,
      constraintSignature,
      expansionHash,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(locale !== undefined ? { locale } : {}),
      redisKey,
    };
  }
}

/**
 * Builder for deterministic result cache keys.
 *
 * Identifies a specific ranked candidate set (for memoization across requests).
 */
export class ResultCacheKeyBuilder {
  /**
   * Build a deterministic cache key for ranked results.
   *
   * @param retrievalProfile - Vespa profile used (e.g., "hybrid")
   * @param topNResults - Number of top results in cache
   * @param filterTuples - Array of applied constraint tuples
   * @param retrievalMode - Mode (determines cacheability)
   * @param anchorEntityId - Optional anchor entity (for similarity search)
   * @returns Deterministic cache key
   */
  build(
    retrievalProfile: string,
    topNResults: number,
    filterTuples: readonly (readonly [string, string, string])[],
    retrievalMode: RetrievalMode,
    anchorEntityId?: string,
  ): ResultCacheKey {
    // Hash filters deterministically
    const sortedFilters = Array.from(filterTuples)
      .sort(([a], [b]) => a.localeCompare(b))
      .map((t) => t.join('|'))
      .join('||');
    const filterSignature = hashDeterministic(sortedFilters);

    // Build Redis key
    const keyParts = [
      'result',
      retrievalProfile,
      topNResults,
      filterSignature,
      retrievalMode,
    ];
    if (anchorEntityId !== undefined) {
      keyParts.push(`anchor:${anchorEntityId}`);
    }
    const redisKey = keyParts.join(':');

    return {
      retrievalProfile,
      topNResults,
      ...(anchorEntityId !== undefined ? { anchorEntityId } : {}),
      filterSignature,
      retrievalMode,
      redisKey,
    };
  }
}

/**
 * Builder for deterministic embedding cache keys.
 *
 * Ensures identical text + model produces identical cache key.
 */
export class EmbeddingCacheKeyBuilder {
  /**
   * Build a deterministic cache key for an embedding.
   *
   * @param text - Text to embed (should be normalized by caller)
   * @param modelId - Model identifier
   * @param instructionPrefix - Optional instruction (e.g., "Search: ")
   * @returns Deterministic cache key
   */
  build(
    text: string,
    modelId: string,
    instructionPrefix?: string,
  ): EmbeddingCacheKey {
    // Redis key from model + instruction prefix + text hash.
    // instructionPrefix distinguishes "Search: " vs "Passage: " embeddings.
    const hashInput = instructionPrefix !== undefined ? `${instructionPrefix}${text}` : text;
    const redisKey = ['embedding', modelId, hashDeterministic(hashInput)].join(':');

    return {
      text,
      modelId,
      ...(instructionPrefix !== undefined ? { instructionPrefix } : {}),
      redisKey,
    };
  }
}

/**
 * Deterministic hash function for cache key components.
 *
 * Uses SHA-256 to produce stable hashes from sorted input strings.
 * Ensures replay consistency: same inputs always produce same hash.
 *
 * @param input - String to hash
 * @returns Hex-encoded SHA-256 hash (16 chars for brevity)
 */
function hashDeterministic(input: string): string {
  return createHash('sha256')
    .update(input)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Pre-computed cache configuration per retrieval mode.
 *
 * Defines cacheability rules and TTL for each mode.
 */
export const CACHE_MODE_CONFIG = {
  entity_lookup: { cacheable: true, ttlSeconds: 3600 },
  entity_resolution: { cacheable: false, ttlSeconds: 0 }, // Ambiguity-dependent
  attribute_search: { cacheable: true, ttlSeconds: 3600 },
  constraint_filter: { cacheable: true, ttlSeconds: 3600 },
  producer_browse: { cacheable: true, ttlSeconds: 1800 },
  region_browse: { cacheable: true, ttlSeconds: 1800 },
  compare_candidates: { cacheable: false, ttlSeconds: 0 }, // Too specific
  recommendation: { cacheable: false, ttlSeconds: 0 }, // User-dependent
  similar_items: { cacheable: false, ttlSeconds: 0 }, // Anchor-dependent
  no_match_detection: { cacheable: false, ttlSeconds: 0 }, // System state-dependent
} as const satisfies Record<RetrievalMode, { readonly cacheable: boolean; readonly ttlSeconds: number }>;
