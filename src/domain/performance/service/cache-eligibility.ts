/**
 * Cache Eligibility Analyzer — Determines if a query should be cached.
 *
 * Not all queries are safe to cache:
 * - entity_lookup, producer_browse, attribute_search: Cacheable (deterministic)
 * - recommendation: Non-cacheable (user preference-dependent)
 * - similar_items: Non-cacheable (anchor-dependent)
 * - compare_candidates: Non-cacheable (too specific)
 *
 * This service enforces cacheability rules to prevent stale cache hits.
 */

import type { QueryPlanV1 } from '../../query/model/query-plan.js';
import type { RetrievalMode } from '../../query/model/retrieval-mode.js';
import type { CompiledWineQuery } from '../../query/model/compiled-wine-query.js';
import { CACHE_MODE_CONFIG } from '../model/cache-key.js';

/**
 * Result of eligibility analysis.
 */
export interface CacheEligibilityResult {
  readonly isCacheable: boolean;
  readonly ttlSeconds: number;
  readonly reason: string;
}

/**
 * Service for analyzing cache eligibility of queries.
 *
 * SOLID: Single Responsibility (only determines cacheability).
 * No side effects, pure function semantics (same inputs → same output).
 */
export class CacheEligibilityAnalyzer {
  /**
   * Analyze if a query should be cached.
   *
   * @param queryPlan - Query plan from planner (contains retrieval mode, intents, etc.)
   * @returns Eligibility decision with TTL
   */
  analyze(queryPlan: QueryPlanV1, compiled?: CompiledWineQuery): CacheEligibilityResult {
    if (compiled === undefined) {
      return {
        isCacheable: false,
        ttlSeconds: 0,
        reason: 'compiled_execution_missing',
      };
    }

    const mode = compiled.execution.effectiveRetrievalMode;

    // Step 1: Check if mode is cacheable at all
    const modeConfig = CACHE_MODE_CONFIG[mode];
    if (!modeConfig.cacheable) {
      return {
        isCacheable: false,
        ttlSeconds: 0,
        reason: `Mode '${mode}' is non-cacheable (context-dependent)`,
      };
    }

    // Step 2: Check for secondary intents that would break caching
    // Note: Only check if secondary intents exist (system may not use them)
    if (queryPlan.secondaryIntents && queryPlan.secondaryIntents.length > 0) {
      // Secondary intents indicate complex queries that may be user-dependent
      // For now, mark as non-cacheable to be conservative
      return {
        isCacheable: false,
        ttlSeconds: 0,
        reason: 'Secondary intents detected (complex query may be user-dependent)',
      };
    }

    // Step 3: Check for session context (session-scoped caching is possible, but still cacheable)
    if (queryPlan.sessionContext) {
      // Session context makes results session-specific, but within session it's cacheable
      // Cache key builder handles session ID inclusion
    }

    // Step 4: Passed all checks, cacheable
    return {
      isCacheable: true,
      ttlSeconds: modeConfig.ttlSeconds,
      reason: `Mode '${mode}' is cacheable with TTL ${modeConfig.ttlSeconds}s`,
    };
  }

  /**
   * Determine if a retrieval mode is globally cacheable.
   *
   * Simpler than full analysis (no session/intent checks).
   * Useful for result-level caching decisions.
   *
   * @param mode - Retrieval mode
   * @returns True if mode is cacheable
   */
  isModeCacheable(mode: RetrievalMode): boolean {
    return CACHE_MODE_CONFIG[mode].cacheable;
  }

  /**
   * Get TTL for a specific retrieval mode.
   *
   * @param mode - Retrieval mode
   * @returns TTL in seconds (0 if not cacheable)
   */
  getTtl(mode: RetrievalMode): number {
    return CACHE_MODE_CONFIG[mode].ttlSeconds;
  }
}
