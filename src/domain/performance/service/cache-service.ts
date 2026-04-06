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

function recordMismatch<T extends string | boolean>(
  a: Readonly<Record<string, T>>,
  b: Readonly<Record<string, T>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return true;
    }
  }
  return false;
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

      // RFC-015: Check version staleness
      const isStale = this.isResponseStale(cached, currentSnapshot);
      if (isStale) {
        // Invalidate stale entry
        try {
          await this.queryCache.delete(cacheKey);
        } catch (err) {
          log.warn({ err }, 'failed to delete stale entry');
        }
        return {
          hit: false,
          isStale: true,
          reason: 'version_mismatch',
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

      await this.queryCache.set(cacheKey, response, eligibility.ttlSeconds);
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
   * RFC-015: Check if cached response's versions match current system versions.
   *
   * Returns true if response is stale (version mismatch).
   */
  private isResponseStale(
    response: SearchResponseV1,
    currentSnapshot: DecisionSnapshot,
  ): boolean {
    const cachedVersions = response.meta.decisionSnapshot;

    // Null check: decisionSnapshot may be undefined in some response types
    if (!cachedVersions) {
      return true; // Treat missing versions as stale
    }

    const modelVersionsMismatch = recordMismatch(
      cachedVersions.model_versions,
      currentSnapshot.model_versions,
    );

    const indexVersionsMismatch = recordMismatch(
      cachedVersions.index_versions,
      currentSnapshot.index_versions,
    );

    // Policy rule version must match
    const policyMismatch = cachedVersions.policy_rule_version !== currentSnapshot.policy_rule_version;
    const thresholdProfileMismatch =
      cachedVersions.threshold_profile_id !== currentSnapshot.threshold_profile_id;
    const plannerMismatch = cachedVersions.planner_version !== currentSnapshot.planner_version;
    const featureFlagsMismatch = recordMismatch(
      cachedVersions.feature_flags,
      currentSnapshot.feature_flags,
    );

    return (
      modelVersionsMismatch
      || indexVersionsMismatch
      || policyMismatch
      || thresholdProfileMismatch
      || plannerMismatch
      || featureFlagsMismatch
    );
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
      this.circuitBreakerOpen = false;
      this.consecutiveErrorCount = 0;
      return false;
    }

    return true;
  }

  /**
   * Record cache error and update circuit breaker.
   */
  private recordCacheError(err: unknown): void {
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
