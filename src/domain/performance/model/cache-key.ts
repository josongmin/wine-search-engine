/**
 * Cache key computation strategies for different layers of the search pipeline.
 *
 * All cache keys must be deterministic from inputs alone (no timestamps/randomness).
 * This ensures replay consistency and enables A/B testing with identical responses.
 */

import type { RetrievalMode } from '../../query/model/retrieval-mode.js';
import { createHash } from 'crypto';
import { MINUTES_PER_HOUR, SECONDS_PER_MINUTE } from '../../shared/utils/time-units.js';

/** 1 hour in seconds — standard TTL for stable entity-level cache entries. */
const ONE_HOUR_SECONDS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE;
/** 30 minutes in seconds — TTL for browse entries that may shift with crawl updates. */
const HALF_HOUR_SECONDS = ONE_HOUR_SECONDS / 2;

/** Truncate SHA-256 hex in Redis keys (bounded length, still low collision rate). */
const CACHE_KEY_HASH_HEX_PREFIX_LENGTH = 16;

/**
 * Canonical Unicode form for every string that feeds a cache-key hash.
 *
 * Korean (한글) text reaches the builder in inconsistent normalization forms:
 * upstream query normalizers variously apply NFC / NFKC / NFD (see
 * `search-constraint-extractor`, `static-ambiguity-dictionary`,
 * `recipient-situation-profile`), and raw constraint values / expansion terms
 * may carry whatever form the source data used. "위" composed (U+C704) and
 * decomposed (U+110B U+1171) are visually identical but hash differently —
 * producing two cache buckets for one semantic query (silent fragmentation:
 * never a wrong hit, always a missed hit). Normalizing to NFC at the hash
 * boundary makes the key canonical regardless of the caller's Unicode form,
 * so the builder OWNS the invariant rather than trusting every upstream path.
 *
 * NFC (not NFKC) is deliberate: NFKC folds compatibility characters (e.g.
 * full-width forms to ASCII, circled-digit to plain digit) which would collapse
 * semantically-distinct inputs into one bucket — a regression in the opposite
 * direction.
 * NFC only canonicalizes encoding of the SAME abstract characters.
 */
function toCanonicalKeyForm(input: string): string {
  return input.normalize('NFC');
}

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
 * Embedding cache key: Identifies embeddings for specific query text.
 *
 * Used for memoizing dense embeddings (reuse for repeated query terms).
 * Very stable: embeddings only change on model upgrade.
 */
export interface EmbeddingCacheKey {
  /** Normalized text being embedded (lowercase, trimmed). */
  readonly text: string;

  /** Embedding model identifier (e.g., "text-embedding-3-small-v1"). */
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
    /**
     * Optional snapshot ID to namespace the cache by deployment epoch.
     * When provided, deploys with new snapshots automatically isolate
     * their cache entries from prior epochs — old keys live in dead key
     * space and expire via TTL instead of being served stale.
     */
    snapshotId?: string,
  ): QueryCacheKey {
    // Hash constraints deterministically (sorted tuples).
    // Use length-prefix encoding to prevent delimiter-collision cache poisoning:
    // a value containing "|" or "||" must not collide with a different
    // (attribute, operator, value) tuple at a different position.
    // Length-prefix encoding is computed on the NFC-canonical field so the
    // prefix length matches the bytes that will be hashed (an NFD field has a
    // different `.length` than its NFC form — encoding the raw length would
    // reintroduce a form-dependent signature even after the final NFC pass).
    const encodeField = (s: string): string => {
      const canonical = toCanonicalKeyForm(s);
      return `${canonical.length}:${canonical}`;
    };
    // Sort on the NFC-canonical fields so tuple ordering is identical
    // regardless of the caller's Unicode form — otherwise NFC vs NFD inputs
    // could sort into different positions and hash differently.
    const sortedConstraints = Array.from(constraintTuples)
      .map((t) => [
        toCanonicalKeyForm(t[0]),
        toCanonicalKeyForm(t[1]),
        toCanonicalKeyForm(t[2]),
      ] as const)
      .sort(([a1, a2, a3], [b1, b2, b3]) =>
        a1.localeCompare(b1) || a2.localeCompare(b2) || a3.localeCompare(b3))
      .map((t) => t.map(encodeField).join('\u0000'))
      .join('\u0001');
    const constraintSignature = hashDeterministic(sortedConstraints);

    // Hash expansions deterministically (NFC-canonical, sorted, length-prefixed).
    const sortedExpansions = Array.from(expansionTerms)
      .map(toCanonicalKeyForm)
      .sort();
    const expansionHash = hashDeterministic(sortedExpansions.map(encodeField).join('\u0000'));

    // Combine components into deterministic Redis key.
    // snapshotId (when provided) namespaces by deploy epoch so a new
    // model/policy snapshot isolates its keys from prior epochs.
    const keyParts: string[] = ['query'];
    if (snapshotId !== undefined && snapshotId.length > 0) {
      // Hash to bound length and avoid leaking the full snapshot id in keys.
      keyParts.push(`s:${hashDeterministic(snapshotId).slice(0, CACHE_KEY_HASH_HEX_PREFIX_LENGTH)}`);
    }
    // Locale is always prefixed with `l:` so a caller-supplied locale string
    // (e.g. `locale='none'` or `locale='l:ko-KR'`) cannot collide with the
    // absent-locale sentinel. Using a bare `'default'` literal — or any literal
    // that is also a valid user locale — produces silent cross-locale cache
    // hits. `l:-` is the absent sentinel (`-` is not a valid locale per RFC
    // 4647), and all present locales are prefixed with `l:`.
    keyParts.push(
      retrievalMode,
      hashDeterministic(normalizedQuery),
      constraintSignature,
      expansionHash,
      locale !== undefined ? `l:${locale}` : 'l:-',
    );
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
    // Use a null-byte delimiter so ("Search:","test") cannot collide with ("Search",":test").
    const hashInput = instructionPrefix !== undefined ? `${instructionPrefix}\u0000${text}` : text;
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
  // NFC at the single hash boundary: every key component (query text,
  // constraint signature, expansion hash, snapshot id, embedding text) is
  // routed through here, so canonicalizing once guarantees Korean / accented
  // inputs in any Unicode form collapse to one cache bucket.
  return createHash('sha256')
    .update(toCanonicalKeyForm(input))
    .digest('hex')
    .substring(0, CACHE_KEY_HASH_HEX_PREFIX_LENGTH);
}

/**
 * Pre-computed cache configuration per retrieval mode.
 *
 * Defines cacheability rules and TTL for each mode.
 */
export const CACHE_MODE_CONFIG = {
  entity_lookup: { cacheable: true, ttlSeconds: ONE_HOUR_SECONDS },
  entity_resolution: { cacheable: false, ttlSeconds: 0 }, // Ambiguity-dependent
  attribute_search: { cacheable: true, ttlSeconds: ONE_HOUR_SECONDS },
  constraint_filter: { cacheable: true, ttlSeconds: ONE_HOUR_SECONDS },
  producer_browse: { cacheable: true, ttlSeconds: HALF_HOUR_SECONDS },
  region_browse: { cacheable: true, ttlSeconds: HALF_HOUR_SECONDS },
  compare_candidates: { cacheable: false, ttlSeconds: 0 }, // Too specific
  recommendation: { cacheable: false, ttlSeconds: 0 }, // User-dependent
  similar_items: { cacheable: false, ttlSeconds: 0 }, // Anchor-dependent
  no_match_detection: { cacheable: false, ttlSeconds: 0 }, // System state-dependent
} as const satisfies Record<RetrievalMode, { readonly cacheable: boolean; readonly ttlSeconds: number }>;
