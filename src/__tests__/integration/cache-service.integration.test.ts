/**
 * Integration tests for CacheService.
 *
 * Tests:
 * - Query cache hit/miss with version freshness checking (RFC-015)
 * - Embedding cache with batch processing
 * - Circuit breaker behavior
 * - Error handling and recovery
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CacheService,
  QueryCacheKeyBuilder,
  EmbeddingCacheKeyBuilder,
} from '../../domain/performance/index.js';
import type { QueryCachePort } from '../../domain/performance/port/query-cache.port.js';
import type { EmbeddingCachePort } from '../../domain/performance/port/embedding-cache.port.js';
import type { QueryCacheKey, EmbeddingCacheKey } from '../../domain/performance/model/cache-key.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';

function buildPlanCacheKey(
  plan: QueryPlanV1,
  request: { sessionContext?: { sessionId: string }; context?: { locale: string } },
): QueryCacheKey {
  const b = new QueryCacheKeyBuilder();
  return b.build(
    plan.normalizedQuery,
    plan.retrievalMode,
    plan.constraints.hard.map((c) => {
      const v = c.value;
      const valueStr =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : JSON.stringify(v);
      return [c.attribute, c.operator, valueStr] as const;
    }),
    [...plan.expansions.lexical, ...plan.expansions.semantic],
    request.sessionContext?.sessionId,
    request.context?.locale,
  );
}

function embeddingLookupKey(text: string, modelId: string): EmbeddingCacheKey {
  return new EmbeddingCacheKeyBuilder().build(text, modelId, 'Search: ');
}

function rawEmbeddingKey(redisKey: string): EmbeddingCacheKey {
  return { text: '', modelId: '', redisKey };
}

const emptyCacheStats = (): Promise<{
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
  readonly entriesCount: number;
}> =>
  Promise.resolve({
    hits: 0,
    misses: 0,
    size: 0,
    entriesCount: 0,
  });

/**
 * Mock implementations for testing.
 */
class MockQueryCache implements QueryCachePort {
  private store = new Map<string, SearchResponseV1>();

  async get(cacheKey: QueryCacheKey): Promise<SearchResponseV1 | undefined> {
    return this.store.get(cacheKey.redisKey);
  }

  async set(cacheKey: QueryCacheKey, response: SearchResponseV1, _ttlSeconds: number): Promise<void> {
    this.store.set(cacheKey.redisKey, response);
  }

  async delete(cacheKey: QueryCacheKey): Promise<void> {
    this.store.delete(cacheKey.redisKey);
  }

  async deletePattern(pattern: string): Promise<number> {
    let n = 0;
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    for (const key of [...this.store.keys()]) {
      const match = pattern.endsWith('*') ? key.startsWith(prefix) : key.includes(pattern);
      if (match) {
        this.store.delete(key);
        n++;
      }
    }
    return n;
  }

  async getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
    readonly entriesCount: number;
  }> {
    return {
      hits: 0,
      misses: 0,
      size: 0,
      entriesCount: this.store.size,
    };
  }

  async clear(): Promise<number> {
    const n = this.store.size;
    this.store.clear();
    return n;
  }
}

class MockEmbeddingCache implements EmbeddingCachePort {
  private store = new Map<string, readonly number[]>();

  async get(cacheKey: EmbeddingCacheKey): Promise<readonly number[] | undefined> {
    return this.store.get(cacheKey.redisKey);
  }

  async set(
    cacheKey: EmbeddingCacheKey,
    embedding: readonly number[],
    _ttlSeconds: number,
  ): Promise<void> {
    this.store.set(cacheKey.redisKey, embedding);
  }

  async delete(cacheKey: EmbeddingCacheKey): Promise<void> {
    this.store.delete(cacheKey.redisKey);
  }

  async deleteByModel(modelId: string): Promise<number> {
    let n = 0;
    for (const key of [...this.store.keys()]) {
      if (key.includes(modelId)) {
        this.store.delete(key);
        n++;
      }
    }
    return n;
  }

  async getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
    readonly entriesCount: number;
  }> {
    return {
      hits: 0,
      misses: 0,
      size: 0,
      entriesCount: this.store.size,
    };
  }

  async clear(): Promise<number> {
    const n = this.store.size;
    this.store.clear();
    return n;
  }
}

describe('CacheService', () => {
  let cacheService: CacheService;
  let queryCache: MockQueryCache;
  let embeddingCache: MockEmbeddingCache;

  beforeEach(() => {
    queryCache = new MockQueryCache();
    embeddingCache = new MockEmbeddingCache();
    cacheService = new CacheService(queryCache, embeddingCache, 5, 60000);
  });

  describe('Query cache', () => {
    it('should return cache miss when no entry exists', async () => {
      const mockPlan = createMockPlan();
      const mockRequest = {};
      const mockSnapshot = createMockSnapshot();

      const result = await cacheService.getSearchResponse(mockPlan, mockRequest, mockSnapshot);

      expect(result.hit).toBe(false);
      expect(result.reason).toBe('cache_miss');
    });

    it('should return cache hit with fresh data', async () => {
      const mockPlan = createMockPlan();
      const mockRequest = {};
      const mockSnapshot = createMockSnapshot();
      const mockResponse = createMockResponse();

      await cacheService.setSearchResponse(mockPlan, mockRequest, mockResponse);

      // Get from cache
      const result = await cacheService.getSearchResponse(mockPlan, mockRequest, mockSnapshot);

      expect(result.hit).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.isStale).toBeUndefined();
    });

    it('should invalidate stale entries with version mismatch', async () => {
      const mockPlan = createMockPlan();
      const mockRequest = {};
      const currentSnapshot = createMockSnapshot('new-model-v2');
      const mockResponse = createMockResponse('old-model-v1');

      await queryCache.set(buildPlanCacheKey(mockPlan, mockRequest), mockResponse, 3600);

      // Try to get with current version
      const result = await cacheService.getSearchResponse(mockPlan, mockRequest, currentSnapshot);

      expect(result.hit).toBe(false);
      expect(result.isStale).toBe(true);
      expect(result.reason).toBe('version_mismatch');
    });

    it('should invalidate stale entries when threshold profile changes', async () => {
      const mockPlan = createMockPlan();
      const mockRequest = {};
      const currentSnapshot = {
        ...createMockSnapshot(),
        threshold_profile_id: 'threshold-v2',
      } satisfies DecisionSnapshot;
      const mockResponse = createMockResponse();

      await queryCache.set(buildPlanCacheKey(mockPlan, mockRequest), mockResponse, 3600);

      const result = await cacheService.getSearchResponse(mockPlan, mockRequest, currentSnapshot);

      expect(result.hit).toBe(false);
      expect(result.isStale).toBe(true);
      expect(result.reason).toBe('version_mismatch');
    });

    it('should invalidate stale entries when feature flags change', async () => {
      const mockPlan = createMockPlan();
      const mockRequest = {};
      const currentSnapshot = {
        ...createMockSnapshot(),
        feature_flags: { killSwitchDenseRetrieval: true },
      } satisfies DecisionSnapshot;
      const mockResponse = createMockResponse();

      await queryCache.set(buildPlanCacheKey(mockPlan, mockRequest), mockResponse, 3600);

      const result = await cacheService.getSearchResponse(mockPlan, mockRequest, currentSnapshot);

      expect(result.hit).toBe(false);
      expect(result.isStale).toBe(true);
      expect(result.reason).toBe('version_mismatch');
    });
  });

  describe('Embedding cache', () => {
    it('should return embeddings with batch processing', async () => {
      const texts = ['hello world', 'foo bar', 'baz'];
      const mockEmbeddingService = {
        embedBatch: vi.fn(async (txts: readonly string[]): Promise<readonly (readonly number[])[]> =>
          txts.map((_, i): readonly number[] =>
            Array.from({ length: 384 }, (): number => i + 0.1),
          ),
        ),
      };

      const result = await cacheService.getOrEmbedBatch(
        texts,
        'test-model',
        mockEmbeddingService,
      );

      expect(result).toHaveLength(3);
      expect(result[0]).toBeDefined();
      expect(mockEmbeddingService.embedBatch).toHaveBeenCalled();
    });

    it('should reuse cached embeddings and only embed uncached ones', async () => {
      const texts = ['hello world', 'foo bar', 'baz'] as const;
      const cachedEmbedding: readonly number[] = Array.from({ length: 384 }, () => 0.5);

      await embeddingCache.set(embeddingLookupKey(texts[0], 'test-model'), cachedEmbedding, 7200);

      const mockEmbeddingService = {
        embedBatch: vi.fn(async (txts: readonly string[]): Promise<readonly (readonly number[])[]> =>
          txts.map((_, i): readonly number[] =>
            Array.from({ length: 384 }, (): number => i + 0.1),
          ),
        ),
      };

      await cacheService.getOrEmbedBatch(texts, 'test-model', mockEmbeddingService);

      expect(mockEmbeddingService.embedBatch).toHaveBeenCalled();
    });

    it('should fallback to embedding service on cache service errors', async () => {
      // Create cache service with non-functional cache
      const failingCache: EmbeddingCachePort = {
        get: async () => {
          throw new Error('Cache error');
        },
        set: async () => {
          throw new Error('Cache error');
        },
        delete: async () => {},
        deleteByModel: async () => 0,
        getStats: emptyCacheStats,
        clear: async () => 0,
      };

      const cacheServiceWithError = new CacheService(queryCache, failingCache);
      const texts = ['hello', 'world'];
      const mockEmbeddingService = {
        embedBatch: vi.fn(async (txts: readonly string[]): Promise<readonly (readonly number[])[]> =>
          txts.map((_, i): readonly number[] =>
            Array.from({ length: 384 }, (): number => i + 0.1),
          ),
        ),
      };

      const result = await cacheServiceWithError.getOrEmbedBatch(
        texts,
        'test-model',
        mockEmbeddingService,
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toBeDefined();
    });
  });

  describe('Circuit breaker', () => {
    it('should not open the circuit breaker before the configured threshold', async () => {
      const failingCache: QueryCachePort = {
        get: async () => {
          throw new Error('Persistent error');
        },
        set: async () => {
          throw new Error('Persistent error');
        },
        delete: async () => {},
        deletePattern: async () => 0,
        getStats: emptyCacheStats,
        clear: async () => 0,
      };

      const cacheServiceWithBreaker = new CacheService(failingCache, undefined, 2, 100);
      const result = await cacheServiceWithBreaker.getSearchResponse(
        createMockPlan(),
        {},
        createMockSnapshot(),
      );

      expect(result.reason).toContain('error:Persistent error');
    });

    it('should open circuit breaker after threshold errors', async () => {
      const failingCache: QueryCachePort = {
        get: async () => {
          throw new Error('Persistent error');
        },
        set: async () => {
          throw new Error('Persistent error');
        },
        delete: async () => {},
        deletePattern: async () => 0,
        getStats: emptyCacheStats,
        clear: async () => 0,
      };

      const cacheServiceWithBreaker = new CacheService(failingCache, undefined, 2, 100);
      const mockPlan = createMockPlan();
      const mockRequest = {};
      const mockSnapshot = createMockSnapshot();

      // Trigger errors to open breaker
      await cacheServiceWithBreaker.getSearchResponse(mockPlan, mockRequest, mockSnapshot);
      await cacheServiceWithBreaker.getSearchResponse(mockPlan, mockRequest, mockSnapshot);

      // Next call should be rejected by circuit breaker
      const result = await cacheServiceWithBreaker.getSearchResponse(
        mockPlan,
        mockRequest,
        mockSnapshot,
      );
      expect(result.reason).toBe('circuit_breaker_open');
    });
  });

  describe('Cache invalidation', () => {
    it('should invalidate embeddings by model ID', async () => {
      await embeddingCache.set(rawEmbeddingKey('embedding:old-model:key1'), [0.1, 0.2], 7200);
      await embeddingCache.set(rawEmbeddingKey('embedding:old-model:key2'), [0.3, 0.4], 7200);
      await embeddingCache.set(rawEmbeddingKey('embedding:new-model:key3'), [0.5, 0.6], 7200);

      await cacheService.invalidateByModel('old-model');

      const oldKey1 = await embeddingCache.get(rawEmbeddingKey('embedding:old-model:key1'));
      const newKey3 = await embeddingCache.get(rawEmbeddingKey('embedding:new-model:key3'));

      expect(oldKey1).toBeUndefined();
      expect(newKey3).toBeDefined();
    });

    it('should invalidate all query cache entries', async () => {
      const mockResponse = createMockResponse();
      const planA = createMockPlan();
      const planB: QueryPlanV1 = {
        ...createMockPlan(),
        normalizedQuery: 'other',
        retrievalMode: 'producer_browse',
      };
      await queryCache.set(buildPlanCacheKey(planA, {}), mockResponse, 3600);
      await queryCache.set(buildPlanCacheKey(planB, {}), mockResponse, 3600);

      await cacheService.invalidateQueryCache();

      expect(await queryCache.get(buildPlanCacheKey(planA, {}))).toBeUndefined();
      expect(await queryCache.get(buildPlanCacheKey(planB, {}))).toBeUndefined();
    });
  });
});

/**
 * Test helpers.
 */
function createMockPlan(_modelVersion = 'test-v1'): QueryPlanV1 {
  return {
    rawQuery: 'test query',
    normalizedQuery: 'test query',
    intent: 'search',
    additionalIntents: [],
    queryClass: 'simple',
    policy: { type: 'default' },
    anchors: [],
    uncertainty: { terms: [], confidence: 0 },
    route: 'hybrid',
    retrievalMode: 'entity_lookup',
    constraints: { hard: [], soft: [] },
    expansions: { lexical: [], semantic: [] },
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    plannerVersion: '1',
  } as unknown as QueryPlanV1;
}

function createMockSnapshot(modelVersion = 'test-v1'): DecisionSnapshot {
  return {
    model_versions: { embedding: modelVersion },
    index_versions: { wine_content: '2026-04-01' },
    policy_rule_version: '1',
    threshold_profile_id: 'default',
    planner_version: '1',
    feature_flags: {},
  };
}

function createMockResponse(modelVersion = 'test-v1'): SearchResponseV1 {
  const decisionSnapshot = createMockSnapshot(modelVersion);
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'test-trace',
      decisionSnapshot,
    },
    results: [],
    meta: {
      requestId: 'test-request-123',
      queryTimeMs: 100,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
      decisionSnapshot,
      response_hash: 'test-hash',
    },
  };
}
