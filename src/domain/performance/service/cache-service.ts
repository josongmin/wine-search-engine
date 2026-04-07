/**
 * Unified cache service with staleness checking, circuit breaking, and observability.
 *
 * Consolidates all caching logic (query, embedding, result) into a single,
 * testable interface. Handles cache invalidation, version checking, and errors.
 *
 * RFC-015 compliance: Validates snapshot versions before returning cached responses.
 */

import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { SearchResponseV1 } from '../../response/model/search-response.js';
import type { DecisionSnapshot } from '../../shared/types/index.js';
import type { QueryCachePort } from '../port/query-cache.port.js';
import type { EmbeddingCachePort } from '../port/embedding-cache.port.js';
import type { SearchResponseCachePort } from '../port/search-response-cache.port.js';
import type { CacheResult } from '../model/cache-result.js';
import { QueryCacheKeyBuilder, EmbeddingCacheKeyBuilder } from '../model/cache-key.js';
import { CacheEligibilityAnalyzer } from './cache-eligibility.js';
import { bootstrapLogger } from '../../../config/bootstrap-logger.js';
import {
  decideResponseCachePolicy,
  decideResponseCacheReadPolicy,
  isDestructiveResponseCacheBypassReason,
  type CacheReadRuntimeState,
} from '../../cache/cache-policy.js';

const log = bootstrapLogger.child({ component: 'CacheService' });

function constraintValueString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
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
    private readonly circuitBreakerResetMs: number = 60000,
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
  ): Promise<CacheResult<SearchResponseV1>> {
    const startTime = Date.now();

    // Check circuit breaker
    if (this.isCircuitBreakerOpen()) {
      return {
        hit: false,
        reason: 'circuit_breaker_open',
        durationMs: Date.now() - startTime,
      };
    }

    // Check eligibility
    const eligibility = this.eligibilityAnalyzer.analyze(plan);
    if (!eligibility.isCacheable || !this.queryCache) {
      return {
        hit: false,
        reason: `not_cacheable:${plan.retrievalMode}`,
        durationMs: Date.now() - startTime,
      };
    }

    try {
      // Build cache key
      const cacheKey = this.queryCacheKeyBuilder.build(
        plan.normalizedQuery,
        plan.retrievalMode,
        plan.constraints.hard.map((c) => [c.attribute, c.operator, constraintValueString(c.value)] as const),
        [...plan.expansions.lexical, ...plan.expansions.semantic],
        request.sessionContext?.sessionId,
        request.context?.locale,
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
  ): Promise<boolean> {
    const eligibility = this.eligibilityAnalyzer.analyze(plan);
    if (!eligibility.isCacheable || !this.queryCache) {
      return false;
    }

    const snapshot = response.meta.decisionSnapshot ?? response.engineDecision.decisionSnapshot;
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
      const cacheKey = this.queryCacheKeyBuilder.build(
        plan.normalizedQuery,
        plan.retrievalMode,
        plan.constraints.hard.map((c) => [c.attribute, c.operator, constraintValueString(c.value)] as const),
        [...plan.expansions.lexical, ...plan.expansions.semantic],
        request.sessionContext?.sessionId,
        request.context?.locale,
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
      const effectiveTtl =
        decisionStatus === 'resolved'
          ? eligibility.ttlSeconds
          : decisionStatus === 'ambiguous'
            ? Math.min(eligibility.ttlSeconds, 60)
            : /* failed */ Math.min(eligibility.ttlSeconds, 30);

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
        if (cached) {
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

        // Store in cache
        for (const [j, idx] of uncachedIndices.entries()) {
          const embedding = mutableEmbeddings[j];
          if (embedding) {
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
    await this.embeddingCache.set(cacheKey, embedding, 7200);
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
    this.consecutiveErrorCount = 0;
  }
}
