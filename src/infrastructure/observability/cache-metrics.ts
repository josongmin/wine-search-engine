/**
 * Cache observability: metrics collection and monitoring.
 *
 * Tracks cache hit/miss rates, latencies, errors, and circuit breaker state.
 * Enables production monitoring and performance analysis.
 */

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
  private queryCacheLatencies: number[] = [];

  private embeddingCacheHits = 0;
  private embeddingCacheMisses = 0;
  private embeddingCacheErrors = 0;
  private embeddingCacheLatencies: number[] = [];

  private circuitBreakerOpen = false;
  private circuitBreakerErrors = 0;
  private circuitBreakerLastError: number | undefined;

  private readonly maxHistorySize = 1000;

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
    if (this.queryCacheLatencies.length > this.maxHistorySize) {
      this.queryCacheLatencies.shift();
    }
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
    if (this.embeddingCacheLatencies.length > this.maxHistorySize) {
      this.embeddingCacheLatencies.shift();
    }
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
    const queryHitRate =
      this.queryCacheHits + this.queryCacheMisses > 0
        ? this.queryCacheHits / (this.queryCacheHits + this.queryCacheMisses)
        : 0;

    const embeddingHitRate =
      this.embeddingCacheHits + this.embeddingCacheMisses > 0
        ? this.embeddingCacheHits / (this.embeddingCacheHits + this.embeddingCacheMisses)
        : 0;

    const queryAvgLatency =
      this.queryCacheLatencies.length > 0
        ? this.queryCacheLatencies.reduce((a, b) => a + b, 0) / this.queryCacheLatencies.length
        : 0;

    const embeddingAvgLatency =
      this.embeddingCacheLatencies.length > 0
        ? this.embeddingCacheLatencies.reduce((a, b) => a + b, 0) / this.embeddingCacheLatencies.length
        : 0;

    // Estimate: query cache hit saves ~200ms, embedding cache hit saves ~80ms
    const estimatedQuerySavingsMs = this.queryCacheHits * 200;
    const estimatedEmbeddingSavingsMs = this.embeddingCacheHits * 80;
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
        avgLatencySavedMs: (queryAvgLatency * queryHitRate + embeddingAvgLatency * embeddingHitRate) / 2,
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
    this.queryCacheLatencies = [];

    this.embeddingCacheHits = 0;
    this.embeddingCacheMisses = 0;
    this.embeddingCacheErrors = 0;
    this.embeddingCacheLatencies = [];

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
