/**
 * Unified cache service with staleness checking, circuit breaking, and observability.
 *
 * Consolidates all caching logic (query, embedding, result) into a single,
 * testable interface. Handles cache invalidation, version checking, and errors.
 *
 * RFC-015 compliance: Validates snapshot versions before returning cached responses.
 */

import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { CompiledWineQuery } from '../../query/model/compiled-wine-query.js';
import type { SearchResponseV1 } from '../../response/model/search-response.js';
import type { DecisionSnapshot } from '../../shared/types/index.js';
import { isCorruptedSnapshot } from '../../shared/types/index.js';
import type { QueryCachePort } from '../port/query-cache.port.js';
import type { EmbeddingCachePort } from '../port/embedding-cache.port.js';
import type { SearchResponseCachePort } from '../port/search-response-cache.port.js';
import type { CacheResult } from '../model/cache-result.js';
import { QueryCacheKeyBuilder, EmbeddingCacheKeyBuilder } from '../model/cache-key.js';
import { CacheEligibilityAnalyzer } from './cache-eligibility.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import { canonicalJsonStringify } from '../../shared/utils/canonical-json.js';
import {
  decideResponseCachePolicy,
  decideResponseCacheReadPolicy,
  isDestructiveResponseCacheBypassReason,
  type CacheReadRuntimeState,
} from '../../cache/cache-policy.js';
import { SECONDS_PER_MINUTE, MINUTES_PER_HOUR, MS_PER_MINUTE } from '../../shared/utils/time-units.js';

const log = bootstrapLogger.child({ component: 'CacheService' });

/** Cap TTL for ambiguous decisions (clarification may change quickly): 1 min. */
const QUERY_RESPONSE_CACHE_TTL_AMBIGUOUS_CAP_SECONDS = SECONDS_PER_MINUTE;
/** Cap TTL for failed decisions (transient errors): 30 s. */
const QUERY_RESPONSE_CACHE_TTL_FAILED_CAP_SECONDS = SECONDS_PER_MINUTE / 2;
/** Embedding vector cache TTL (seconds) — model-stable vectors: 2 hours. */
const EMBEDDING_VECTOR_CACHE_TTL_SECONDS = 2 * SECONDS_PER_MINUTE * MINUTES_PER_HOUR;

function constraintValueString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // canonicalJsonStringify sorts object keys → range constraints
  // ({min, max} vs {max, min}) hash to the same cache key. Plain
  // JSON.stringify is order-dependent and produces a hidden cache miss.
  // (Bugbash R19 critical re-audit)
  return canonicalJsonStringify(value);
}

function buildSnapshotCachePolicyRef(snapshot: DecisionSnapshot): string {
  return snapshot.snapshot_id;
}

/**
 * Unified cache service for search responses.
 *
 * Handles:
 * - Deterministic cache key generation
 * - Version staleness checking (RFC-015)
 * - Cache eligibility analysis
 * - Error recovery and observability
 * - Circuit breaking for backend failures
 */
export class CacheService implements SearchResponseCachePort {
  private readonly queryCacheKeyBuilder: QueryCacheKeyBuilder;
  private readonly embeddingCacheKeyBuilder: EmbeddingCacheKeyBuilder;
  private readonly eligibilityAnalyzer: CacheEligibilityAnalyzer;
  private readonly circuitBreakerThreshold: number;
  private circuitBreakerOpen = false;
  private circuitBreakerResetTime = 0;
  private consecutiveErrorCount = 0;
  /**
   * Monotonically-increasing counter incremented on every state transition
   * (open → closed, closed → open).  Concurrent async paths that captured a
   * stale snapshot can compare against the current version to detect that the
   * circuit breaker was mutated between their read and write, and bail out
   * instead of clobbering the newer state.
   */
  private _circuitBreakerVersion = 0;

  constructor(
    private readonly queryCache: QueryCachePort | undefined,
    private readonly embeddingCache: EmbeddingCachePort | undefined,
    circuitBreakerThreshold: number = 5,
    private readonly circuitBreakerResetMs: number = MS_PER_MINUTE,
  ) {
    this.queryCacheKeyBuilder = new QueryCacheKeyBuilder();
    this.embeddingCacheKeyBuilder = new EmbeddingCacheKeyBuilder();
    this.eligibilityAnalyzer = new CacheEligibilityAnalyzer();
    this.circuitBreakerThreshold = Math.max(1, circuitBreakerThreshold);
  }

  /**
   * Get cached search response if eligible and fresh.
   *
   * Validates:
   * - Cache eligibility per retrieval mode
   * - Snapshot version freshness (RFC-015)
   * - Circuit breaker state
   *
   * @param plan - Query plan
   * @param request - Original request
   * @param currentSnapshot - Current snapshot version info
   * @returns Cache result with hit status and data
   */
  async getSearchResponse(
    plan: QueryPlanV1,
    request: {
      sessionContext?: { sessionId: string };
      context?: { locale: string };
    },
    currentSnapshot: DecisionSnapshot,
    runtimeState?: CacheReadRuntimeState,
    compiled?: CompiledWineQuery,
  ): Promise<CacheResult<SearchResponseV1>> {
    const startTime = Date.now();

    // Corrupted snapshots must never participate in cache lookups — the
    // sentinel snapshot_id ('__corrupted__') would either pollute a cache
    // slot or return stale data keyed under a nonsense version string.
    if (isCorruptedSnapshot(currentSnapshot)) {
      log.warn('Skipping cache read: corrupted decision snapshot');
      return {
        hit: false,
        reason: 'corrupted_snapshot',
        durationMs: Date.now() - startTime,
      };
    }

    // Check circuit breaker
    if (this.isCircuitBreakerOpen()) {
      return {
        hit: false,
        reason: 'circuit_breaker_open',
        durationMs: Date.now() - startTime,
      };
    }

    // Check eligibility
    const eligibility = this.eligibilityAnalyzer.analyze(plan, compiled);
    if (!eligibility.isCacheable || !this.queryCache) {
      return {
        hit: false,
        reason: `not_cacheable:${compiled?.execution.effectiveRetrievalMode ?? plan.retrievalMode}`,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      const effectiveRetrievalMode = compiled?.execution.effectiveRetrievalMode ?? plan.retrievalMode;
      // Build cache key. Include snapshot_id so a deploy with a new
      // policy/model snapshot automatically isolates fresh keys from
      // prior-epoch entries — avoiding stale-result reads while old
      // entries decay via TTL.
      const cacheKey = this.queryCacheKeyBuilder.build(
        plan.normalizedQuery,
        effectiveRetrievalMode,
        [
          ...plan.constraints.hard.map((c) => [c.attribute, c.operator, constraintValueString(c.value)] as const),
          ...plan.constraints.soft.map((c) => [`soft:${c.attribute}`, c.operator, constraintValueString(c.value)] as const),
        ],
        [
          ...plan.expansions.lexical.map((t) => `L:${t}`),
          ...plan.expansions.semantic.map((t) => `S:${t}`),
        ],
        request.sessionContext?.sessionId,
        request.context?.locale,
        currentSnapshot.snapshot_id,
      );

      // Get from cache
      const cached = await this.queryCache.get(cacheKey);
      if (!cached) {
        return {
          hit: false,
          reason: 'cache_miss',
          durationMs: Date.now() - startTime,
        };
      }

      const cachedSnapshot = cached.meta.decisionSnapshot ?? cached.engineDecision.decisionSnapshot;
      const cachedBlockingEligible = cached.meta.blockingEligible ?? cached.engineDecision.blockingEligible;
      const readPolicy = decideResponseCacheReadPolicy({
        cachedExecutionMode:
          cached.meta.executionMode ?? cached.engineDecision.executionMode ?? 'authoritative',
        ...(cachedBlockingEligible !== undefined ? { cachedBlockingEligible } : {}),
        cachedSnapshotId: cachedSnapshot.snapshot_id,
        cachedModelVersions: cachedSnapshot.model_versions,
        cachedContractVersion:
          cachedSnapshot.response_contract_version,
        currentSnapshotId: currentSnapshot.snapshot_id,
        currentContractVersion: currentSnapshot.response_contract_version,
        currentModelVersions: currentSnapshot.model_versions,
        ...(runtimeState !== undefined ? { runtimeState } : {}),
      });

      if (readPolicy.eligibility === 'bypass') {
        if (isDestructiveResponseCacheBypassReason(readPolicy.reason)) {
          try {
            await this.queryCache.delete(cacheKey);
          } catch (err) {
            log.warn({ err }, 'failed to delete stale entry');
          }
        }
        return {
          hit: false,
          isStale: true,
          ...(readPolicy.reason !== undefined ? { reason: readPolicy.reason } : {}),
          durationMs: Date.now() - startTime,
        };
      }

      this.recordCacheSuccess();
      return {
        hit: true,
        data: cached,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      this.recordCacheError(err);
      return {
        hit: false,
        reason: `error:${(err as Error).message}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Store search response if eligible.
   *
   * @param plan - Query plan
   * @param request - Original request
   * @param response - Response to cache
   * @returns Success status
   */
  async setSearchResponse(
    plan: QueryPlanV1,
    request: {
      sessionContext?: { sessionId: string };
      context?: { locale: string };
    },
    response: SearchResponseV1,
    compiled?: CompiledWineQuery,
  ): Promise<boolean> {
    const eligibility = this.eligibilityAnalyzer.analyze(plan, compiled);
    if (!eligibility.isCacheable || !this.queryCache) {
      return false;
    }

    const snapshot = response.meta.decisionSnapshot ?? response.engineDecision.decisionSnapshot;
    if (isCorruptedSnapshot(snapshot)) {
      log.warn('Skipping cache write: response contains corrupted decision snapshot');
      return false;
    }
    const policy = decideResponseCachePolicy({
      executionMode: response.meta.executionMode ?? response.engineDecision.executionMode ?? 'authoritative',
      snapshotId: buildSnapshotCachePolicyRef(snapshot),
      ...(
        response.meta.blockingEligible !== undefined || response.engineDecision.blockingEligible !== undefined
          ? {
              blockingEligible:
                response.meta.blockingEligible ?? response.engineDecision.blockingEligible,
            }
          : {}
      ),
    });
    if (policy.eligibility === 'non_cacheable') {
      log.debug({ reason: policy.reason }, 'Skipping response cache write due to response contract policy');
      return false;
    }

    if (this.isCircuitBreakerOpen()) {
      return false;
    }

    try {
      const effectiveRetrievalMode = compiled?.execution.effectiveRetrievalMode ?? plan.retrievalMode;
      const cacheKey = this.queryCacheKeyBuilder.build(
        plan.normalizedQuery,
        effectiveRetrievalMode,
        [
          ...plan.constraints.hard.map((c) => [c.attribute, c.operator, constraintValueString(c.value)] as const),
          ...plan.constraints.soft.map((c) => [`soft:${c.attribute}`, c.operator, constraintValueString(c.value)] as const),
        ],
        [
          ...plan.expansions.lexical.map((t) => `L:${t}`),
          ...plan.expansions.semantic.map((t) => `S:${t}`),
        ],
        request.sessionContext?.sessionId,
        request.context?.locale,
        snapshot.snapshot_id,
      );

      // Stratify TTL by decision status (Bug fix: non-resolved responses must
      // not occupy cache slots for the full retrieval-mode TTL).
      //
      // - resolved   → full TTL (the result is stable until the snapshot drifts)
      // - ambiguous  → 60 s   (ambiguity often clears after a query reformulation;
      //                         a long TTL would keep "please clarify" stale in the
      //                         cache while the index or model has moved on)
      // - failed     → 30 s   (failure is frequently transient; short TTL limits
      //                         blast radius while still absorbing retry bursts)
      const decisionStatus = response.engineDecision.decisionStatus;
      const rawTtl =
        decisionStatus === 'resolved'
          ? eligibility.ttlSeconds
          : decisionStatus === 'ambiguous'
            ? Math.min(eligibility.ttlSeconds, QUERY_RESPONSE_CACHE_TTL_AMBIGUOUS_CAP_SECONDS)
            : /* failed */ Math.min(eligibility.ttlSeconds, QUERY_RESPONSE_CACHE_TTL_FAILED_CAP_SECONDS);
      // Redis SET ... EX 0 is rejected — never write a non-positive TTL.
      // A min of 1s caps the worst case (write+immediate-expiry) without
      // crashing the writer path.
      const effectiveTtl = Math.max(1, Math.floor(rawTtl));

      await this.queryCache.set(cacheKey, response, effectiveTtl);
      this.recordCacheSuccess();
      return true;
    } catch (err) {
      this.recordCacheError(err);
      return false;
    }
  }

  /**
   * Get embedding from cache, with fallback to embedding service.
   *
   * @param text - Text to embed
   * @param modelId - Embedding model identifier
   * @param embeddingService - Service to embed uncached texts
   * @returns Embedding vector or null
   */
  async getOrEmbedBatch(
    texts: readonly string[],
    modelId: string,
    embeddingService: {
      embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
    },
  ): Promise<(readonly number[] | null)[]> {
    if (!this.embeddingCache || this.isCircuitBreakerOpen()) {
      // Fallback: embed all without caching
      const embeddings = await embeddingService.embedBatch(texts);
      return embeddings.slice() as (readonly number[] | null)[];
    }

    const results: (readonly number[] | null)[] = [];
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = []; // Mutable copy for batch processing

    try {
      // Check cache for each text
      for (const text of texts) {
        const cacheKey = this.embeddingCacheKeyBuilder.build(
          text,
          modelId,
          'Search: ',
        );

        const cached = await this.embeddingCache.get(cacheKey);
        if (cached != null && cached.length > 0) {
          results.push(cached);
        } else {
          results.push(null);
          uncachedIndices.push(results.length - 1);
          uncachedTexts.push(text);
        }
      }

      // Embed only uncached texts
      if (uncachedTexts.length > 0) {
        // Make mutable copy to satisfy embedBatch interface
        const newEmbeddings = await embeddingService.embedBatch(uncachedTexts);
        const mutableEmbeddings = newEmbeddings.slice();
        // Critical correctness check: the embedding service must return one
        // vector per input text in the same order. A truncated or reordered
        // response would silently associate wrong vectors with wrong texts.
        if (mutableEmbeddings.length !== uncachedTexts.length) {
          throw new Error(
            `Embedding service returned ${mutableEmbeddings.length} vectors for ${uncachedTexts.length} texts`,
          );
        }

        // Derive expected dimension from the first fresh embedding so we can
        // cross-check any cached vectors that landed in the same batch.
        // A stale cache entry from a different model checkpoint has the wrong
        // dimension and would silently corrupt cosine-similarity ranking.
        const freshDimension = mutableEmbeddings[0]?.length ?? 0;

        // Evict cached embeddings whose dimension doesn't match the live model.
        if (freshDimension > 0) {
          for (let ri = 0; ri < results.length; ri++) {
            const r = results[ri];
            if (r != null && r.length !== freshDimension) {
              log.warn(
                { cachedDimension: r.length, freshDimension },
                '[CacheService] cached embedding dimension mismatch — evicting stale entry',
              );
              results[ri] = null;
              // Re-add to uncached so it is re-embedded below (next call path)
            }
          }
        }

        // Store in cache
        for (const [j, idx] of uncachedIndices.entries()) {
          const embedding = mutableEmbeddings[j];
          if (embedding !== undefined && embedding.length > 0) {
            results[idx] = embedding;
            const text = texts[idx];
            if (text) {
              this.storeEmbeddingInCache(text, modelId, embedding).catch((err: unknown) => {
                log.warn({ err }, 'failed to cache embedding');
              });
            }
          }
        }
      }

      this.recordCacheSuccess();
      return results;
    } catch (err) {
      this.recordCacheError(err);
      // Fallback: embed everything
      const embeddings = await embeddingService.embedBatch(texts);
      return embeddings.slice() as (readonly number[] | null)[];
    }
  }

  /**
   * Invalidate all caches for a given model.
   *
   * Called when embedding model is upgraded.
   */
  async invalidateByModel(modelId: string): Promise<void> {
    try {
      await this.embeddingCache?.deleteByModel(modelId);
    } catch (err) {
      log.error({ err }, 'failed to invalidate by model');
    }
  }

  /**
   * Invalidate all query caches (e.g., on policy update).
   */
  async invalidateQueryCache(): Promise<void> {
    try {
      await this.queryCache?.deletePattern('query:*');
    } catch (err) {
      log.error({ err }, 'failed to invalidate query cache');
    }
  }

  /**
   * Get cache statistics for observability.
   */
  async getStats(): Promise<Record<string, unknown>> {
    const stats: Record<string, unknown> = {
      circuitBreakerOpen: this.isCircuitBreakerOpen(),
    };

    try {
      if (this.queryCache) {
        const queryStats = await this.queryCache.getStats();
        stats.queryCache = queryStats;
      }
    } catch (err) {
      stats.queryCacheError = (err as Error).message;
    }

    return stats;
  }
  /**
   * Store embedding in cache (non-blocking).
   */
  private async storeEmbeddingInCache(
    text: string,
    modelId: string,
    embedding: readonly number[],
  ): Promise<void> {
    if (!this.embeddingCache) return;

    const cacheKey = this.embeddingCacheKeyBuilder.build(text, modelId, 'Search: ');
    await this.embeddingCache.set(cacheKey, embedding, EMBEDDING_VECTOR_CACHE_TTL_SECONDS);
  }

  /**
   * Check if circuit breaker should be open.
   *
   * Opens breaker after threshold errors, closes after reset window.
   */
  private isCircuitBreakerOpen(): boolean {
    if (!this.circuitBreakerOpen) return false;

    const now = Date.now();
    if (now > this.circuitBreakerResetTime) {
      // Atomically transition open → closed and reset the error counter in the
      // same synchronous operation.  Because JavaScript is single-threaded,
      // no await intervenes here, so no concurrent path can observe a
      // half-transitioned state (open=false but errorCount still > 0).
      this.circuitBreakerOpen = false;
      this.consecutiveErrorCount = 0;
      this._circuitBreakerVersion += 1;
      return false;
    }

    return true;
  }

  /**
   * Record cache error and update circuit breaker.
   */
  private recordCacheError(err: unknown): void {
    // Idempotency guard: if the circuit is already open, further errors from
    // in-flight requests that slipped through before the breaker tripped must
    // not keep inflating the counter.  The counter is reset atomically when the
    // breaker closes (see isCircuitBreakerOpen), so we must not overwrite that
    // reset with a stale increment.
    if (this.circuitBreakerOpen) {
      return;
    }

    this.consecutiveErrorCount += 1;
    log.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        consecutiveErrorCount: this.consecutiveErrorCount,
        circuitBreakerThreshold: this.circuitBreakerThreshold,
      },
      'cache operation failed',
    );

    if (this.consecutiveErrorCount < this.circuitBreakerThreshold) {
      return;
    }

    this.circuitBreakerOpen = true;
    this.circuitBreakerResetTime = Date.now() + this.circuitBreakerResetMs;
    this._circuitBreakerVersion += 1;
    log.warn(
      {
        consecutiveErrorCount: this.consecutiveErrorCount,
        circuitBreakerResetMs: this.circuitBreakerResetMs,
      },
      'circuit breaker opened after repeated cache failures',
    );
  }

  private recordCacheSuccess(): void {
    // Symmetric with recordCacheError: do not heal the breaker counter while
    // the breaker is open. A request that began before the breaker opened can
    // resolve cleanly mid-window and would otherwise reset
    // consecutiveErrorCount to 0, prematurely "healing" a flapping backend.
    if (this.circuitBreakerOpen) {
      return;
    }
    this.consecutiveErrorCount = 0;
  }
}
