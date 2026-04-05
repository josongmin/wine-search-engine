/**
 * Domain-level exports for the Performance layer.
 *
 * Performance domain handles:
 * - Cache key computation (query, result, embedding levels)
 * - Cache eligibility analysis (determine if query should be cached)
 * - Domain ports for caching infrastructure (QueryCachePort, EmbeddingCachePort)
 * - Cache configuration per retrieval mode
 *
 * Implements RFC-018 (Performance Optimization & Caching) following SOLID principles
 * and hexagonal architecture (caching as infrastructure concern expressed as domain port).
 */

// Models
export {
  type QueryCacheKey,
  type ResultCacheKey,
  type EmbeddingCacheKey,
  QueryCacheKeyBuilder,
  ResultCacheKeyBuilder,
  EmbeddingCacheKeyBuilder,
  CACHE_MODE_CONFIG,
} from './model/cache-key.js';

// Ports
export type { QueryCachePort } from './port/query-cache.port.js';
export type { EmbeddingCachePort } from './port/embedding-cache.port.js';

// Services
export {
  CacheEligibilityAnalyzer,
  type CacheEligibilityResult,
} from './service/cache-eligibility.js';
