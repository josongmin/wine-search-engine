/**
 * Cache observability: metrics collection and monitoring.
 *
 * Tracks cache hit/miss rates, latencies, errors, and circuit breaker state.
 * Enables production monitoring and performance analysis.
 */

import { CircularLatencyBuffer } from './circular-latency-buffer.js';

/** Rough heuristic for dashboard “estimated savings” (not wall-clock measured). */
const ESTIMATED_MS_SAVED_PER_QUERY_CACHE_HIT = 200;
const ESTIMATED_MS_SAVED_PER_EMBEDDING_CACHE_HIT = 80;

export interface CacheMetrics {
  readonly queryCache: {
    readonly hits: number;
    readonly misses: number;
    readonly errors: number;
    readonly avgLatencyMs: number;
    readonly hitRate: number;
  };
  readonly embeddingCache: {
    readonly hits: number;
    readonly misses: number;
    readonly errors: number;
    readonly avgLatencyMs: number;
    readonly hitRate: number;
  };
  readonly circuitBreaker: {
    readonly isOpen: boolean;
    readonly errorCount: number;
    readonly lastErrorTime?: number;
  };
  readonly overall: {
    readonly avgLatencySavedMs: number;
    readonly estimatedQueriesSavedMs: number;
  };
}

/**
 * Records cache metrics for observability.
 *
 * Production-grade metrics collection with minimal overhead.
 */
export class CacheMetricsCollector {
  private queryCacheHits = 0;
  private queryCacheMisses = 0;
  private queryCacheErrors = 0;
  private readonly queryCacheLatencies = new CircularLatencyBuffer(1000);

  private embeddingCacheHits = 0;
  private embeddingCacheMisses = 0;
  private embeddingCacheErrors = 0;
  private readonly embeddingCacheLatencies = new CircularLatencyBuffer(1000);

  private circuitBreakerOpen = false;
  private circuitBreakerErrors = 0;
  private circuitBreakerLastError: number | undefined;

  /**
   * Record query cache operation.
   */
  recordQueryCacheOperation(hit: boolean, latencyMs: number, error?: boolean): void {
    if (error) {
      this.queryCacheErrors++;
    } else if (hit) {
      this.queryCacheHits++;
    } else {
      this.queryCacheMisses++;
    }

    this.queryCacheLatencies.push(latencyMs);
  }

  /**
   * Record embedding cache operation.
   */
  recordEmbeddingCacheOperation(hit: boolean, latencyMs: number, error?: boolean): void {
    if (error) {
      this.embeddingCacheErrors++;
    } else if (hit) {
      this.embeddingCacheHits++;
    } else {
      this.embeddingCacheMisses++;
    }

    this.embeddingCacheLatencies.push(latencyMs);
  }

  /**
   * Record circuit breaker state change.
   */
  recordCircuitBreakerOpened(errorCount: number): void {
    this.circuitBreakerOpen = true;
    this.circuitBreakerErrors = errorCount;
    this.circuitBreakerLastError = Date.now();
  }

  /**
   * Record circuit breaker reset.
   */
  recordCircuitBreakerClosed(): void {
    this.circuitBreakerOpen = false;
    this.circuitBreakerErrors = 0;
  }

  /**
   * Get current metrics snapshot.
   */
  getMetrics(): CacheMetrics {
    const queryTotal = this.queryCacheHits + this.queryCacheMisses + this.queryCacheErrors;
    const queryHitRate = queryTotal > 0
      ? this.queryCacheHits / queryTotal
      : 0;

    const embeddingTotal = this.embeddingCacheHits + this.embeddingCacheMisses + this.embeddingCacheErrors;
    const embeddingHitRate = embeddingTotal > 0
      ? this.embeddingCacheHits / embeddingTotal
      : 0;

    const queryAvgLatency = this.queryCacheLatencies.average();
    const embeddingAvgLatency = this.embeddingCacheLatencies.average();

    const estimatedQuerySavingsMs =
      this.queryCacheHits * ESTIMATED_MS_SAVED_PER_QUERY_CACHE_HIT;
    const estimatedEmbeddingSavingsMs =
      this.embeddingCacheHits * ESTIMATED_MS_SAVED_PER_EMBEDDING_CACHE_HIT;
    const totalEstimatedSavingsMs = estimatedQuerySavingsMs + estimatedEmbeddingSavingsMs;

    // Build object with proper optional handling for exactOptionalPropertyTypes
    const circuitBreakerMetrics: CacheMetrics['circuitBreaker'] = {
      isOpen: this.circuitBreakerOpen,
      errorCount: this.circuitBreakerErrors,
      ...(this.circuitBreakerLastError !== undefined ? { lastErrorTime: this.circuitBreakerLastError } : {}),
    };

    return {
      queryCache: {
        hits: this.queryCacheHits,
        misses: this.queryCacheMisses,
        errors: this.queryCacheErrors,
        avgLatencyMs: queryAvgLatency,
        hitRate: queryHitRate,
      },
      embeddingCache: {
        hits: this.embeddingCacheHits,
        misses: this.embeddingCacheMisses,
        errors: this.embeddingCacheErrors,
        avgLatencyMs: embeddingAvgLatency,
        hitRate: embeddingHitRate,
      },
      circuitBreaker: circuitBreakerMetrics,
      overall: {
        avgLatencySavedMs:
          this.queryCacheHits + this.embeddingCacheHits > 0
            ? totalEstimatedSavingsMs / (this.queryCacheHits + this.embeddingCacheHits)
            : 0,
        estimatedQueriesSavedMs: totalEstimatedSavingsMs,
      },
    };
  }

  /**
   * Reset all metrics (for testing).
   */
  reset(): void {
    this.queryCacheHits = 0;
    this.queryCacheMisses = 0;
    this.queryCacheErrors = 0;
    this.queryCacheLatencies.reset();

    this.embeddingCacheHits = 0;
    this.embeddingCacheMisses = 0;
    this.embeddingCacheErrors = 0;
    this.embeddingCacheLatencies.reset();

    this.circuitBreakerOpen = false;
    this.circuitBreakerErrors = 0;
    this.circuitBreakerLastError = undefined;
  }
}

/**
 * Global metrics collector instance (singleton).
 */
let globalMetricsCollector: CacheMetricsCollector | undefined;

/**
 * Get or create the global metrics collector.
 */
export function getMetricsCollector(): CacheMetricsCollector {
  if (!globalMetricsCollector) {
    globalMetricsCollector = new CacheMetricsCollector();
  }
  return globalMetricsCollector;
}
