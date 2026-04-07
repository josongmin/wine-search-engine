import { beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from '../../domain/performance/index.js';
import type { QueryCachePort } from '../../domain/performance/port/query-cache.port.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { SearchResponseV1 } from '../../domain/response/model/search-response.js';
import type { DecisionSnapshot } from '../../domain/shared/types/index.js';
import {
  MockEmbeddingCache,
  MockQueryCache,
  authoritativeRuntimeState,
  buildPlanCacheKey,
  createMockPlan,
  createMockResponse,
  createMockSnapshot,
} from './helpers/cache-service-test-helpers.js';

describe('CacheService query cache integration', () => {
  let cacheService: CacheService;
  let queryCache: MockQueryCache;
  let embeddingCache: MockEmbeddingCache;

  beforeEach(() => {
    queryCache = new MockQueryCache();
    embeddingCache = new MockEmbeddingCache();
    cacheService = new CacheService(queryCache, embeddingCache, 5, 60000);
  });

  async function seedFreshCachedResponse(
    response = createMockResponse(),
    request: { sessionContext?: { sessionId: string }; context?: { locale: string } } = {},
  ): Promise<{
    readonly plan: QueryPlanV1;
    readonly request: { sessionContext?: { sessionId: string }; context?: { locale: string } };
  }> {
    const plan = createMockPlan();
    await cacheService.setSearchResponse(plan, request, response);
    return { plan, request };
  }

  async function captureQueryCacheTtl(
    response: SearchResponseV1,
  ): Promise<number> {
    const plan = createMockPlan();
    const request = {};

    let capturedTtl = 0;
    const delegateCache = new MockQueryCache();
    const spyCache: QueryCachePort = {
      get: (k) => delegateCache.get(k),
      set: async (k, v, ttl) => {
        capturedTtl = ttl;
        return delegateCache.set(k, v, ttl);
      },
      delete: (k) => delegateCache.delete(k),
      deletePattern: (p) => delegateCache.deletePattern(p),
      getStats: () => delegateCache.getStats(),
      clear: () => delegateCache.clear(),
    };
    const spyService = new CacheService(spyCache, embeddingCache, 5, 60000);

    await spyService.setSearchResponse(plan, request, response);
    return capturedTtl;
  }

  async function seedDirectCachedResponse(
    response: SearchResponseV1,
    request: { sessionContext?: { sessionId: string }; context?: { locale: string } } = {},
  ) {
    const plan = createMockPlan();
    await queryCache.set(buildPlanCacheKey(plan, request), response, 3600);
    return { plan, request };
  }

  async function expectCacheBypass(
    response: SearchResponseV1,
    expectedReason: string,
    options: {
      snapshot?: DecisionSnapshot;
      runtimeState?: ReturnType<typeof authoritativeRuntimeState>;
      request?: { sessionContext?: { sessionId: string }; context?: { locale: string } };
    } = {},
  ) {
    const { plan, request } = await seedDirectCachedResponse(response, options.request);
    const result = await cacheService.getSearchResponse(
      plan,
      request,
      options.snapshot ?? createMockSnapshot(),
      options.runtimeState,
    );
    expect(result.hit).toBe(false);
    expect(result.reason).toBe(expectedReason);
    return { result, plan, request };
  }

  it('returns cache miss when no entry exists', async () => {
    const result = await cacheService.getSearchResponse(createMockPlan(), {}, createMockSnapshot());

    expect(result.hit).toBe(false);
    expect(result.reason).toBe('cache_miss');
  });

  it('returns cache hit with fresh data', async () => {
    const mockPlan = createMockPlan();
    const mockRequest = {};
    const mockSnapshot = createMockSnapshot();
    const mockResponse = createMockResponse();

    await cacheService.setSearchResponse(mockPlan, mockRequest, mockResponse);

    const result = await cacheService.getSearchResponse(mockPlan, mockRequest, mockSnapshot, {
      learningKillSwitchEnabled: false,
      denseRetrievalEnabled: true,
      rerankerAvailable: true,
      currentExecutionModeHint: 'authoritative',
    });

    expect(result.hit).toBe(true);
    expect(result.data?.meta.requestId).toBe('test-request-123');
    expect(result.isStale).toBeUndefined();
  });

  it('refuses caching heuristic responses even on cacheable routes', async () => {
    const mockPlan = createMockPlan();
    const mockRequest = {};
    const mockResponse = createMockResponse('test-v1', {
      executionMode: 'heuristic',
      blockingEligible: false,
      degradationReasons: ['heuristic_drinking_window'],
    });

    await expect(
      cacheService.setSearchResponse(mockPlan, mockRequest, mockResponse),
    ).resolves.toBe(false);

    const result = await cacheService.getSearchResponse(
      mockPlan,
      mockRequest,
      createMockSnapshot(),
      authoritativeRuntimeState(),
    );
    expect(result.hit).toBe(false);
  });

  it('invalidates stale entries with version mismatch', async () => {
    const { result } = await expectCacheBypass(
      createMockResponse('old-model-v1'),
      'model_version_drift',
      { snapshot: createMockSnapshot('new-model-v2') },
    );
    expect(result.isStale).toBe(true);
  });

  it.each([
    [
      'threshold profile changes',
      createMockSnapshot('test-v1', { threshold_profile_id: 'threshold-v2' }),
    ],
    [
      'feature flags change',
      createMockSnapshot('test-v1', { feature_flags: { killSwitchDenseRetrieval: true } }),
    ],
  ])('invalidates stale entries when %s', async (_label, currentSnapshot) => {
    const { result } = await expectCacheBypass(createMockResponse(), 'snapshot_id_drift', {
      snapshot: currentSnapshot,
    });
    expect(result.isStale).toBe(true);
  });

  it('bypasses degraded cached entries even when the key matches', async () => {
    const { result } = await expectCacheBypass(createMockResponse('test-v1', {
      executionMode: 'degraded',
      blockingEligible: false,
      degradationReasons: ['reranker_unavailable'],
    }), 'cached_not_blocking_eligible');
    expect(result.isStale).toBe(true);
  });

  it('bypasses contract-version drift with a stable reason', async () => {
    const { result } = await expectCacheBypass(createMockResponse('test-v1', {
      contractVersion: 'search_response_v0',
    }), 'contract_version_drift');
    expect(result.isStale).toBe(true);
  });

  it.each([
    [
      'learning is kill-switched at runtime',
      {
        learningKillSwitchEnabled: true,
        denseRetrievalEnabled: true,
        rerankerAvailable: true,
        currentExecutionModeHint: 'degraded' as const,
      },
      'learning_disabled',
    ],
    [
      'dense retrieval is disabled at runtime',
      {
        learningKillSwitchEnabled: false,
        denseRetrievalEnabled: false,
        rerankerAvailable: true,
        currentExecutionModeHint: 'degraded' as const,
      },
      'dense_retrieval_disabled',
    ],
    [
      'reranker is unavailable at runtime',
      {
        learningKillSwitchEnabled: false,
        denseRetrievalEnabled: true,
        rerankerAvailable: false,
        currentExecutionModeHint: 'degraded' as const,
      },
      'reranker_unavailable',
    ],
  ])('bypasses cache hits when %s', async (_label, runtimeState, reason) => {
    const { plan, request } = await seedFreshCachedResponse();

    const result = await cacheService.getSearchResponse(
      plan,
      request,
      createMockSnapshot(),
      runtimeState,
    );

    expect(result.hit).toBe(false);
    expect(result.reason).toBe(reason);
    expect((await queryCache.get(buildPlanCacheKey(plan, request)))?.meta.requestId).toBe('test-request-123');
  });

  it('fails closed when cached model versions are missing', async () => {
    const response = createMockResponse('test-v1');
    const snapshotWithoutModels: DecisionSnapshot = {
      ...response.meta.decisionSnapshot!,
      model_versions: {},
    };
    response.meta.decisionSnapshot = snapshotWithoutModels;
    response.engineDecision.decisionSnapshot = snapshotWithoutModels;

    const { result } = await expectCacheBypass(response, 'model_version_drift', {
      runtimeState: authoritativeRuntimeState(),
    });
    expect(result.isStale).toBe(true);
  });

  it('refuses to write non-blocking-eligible responses to cache', async () => {
    const mockPlan = createMockPlan();
    const mockRequest = {};
    const nonBlockingResponse = createMockResponse('test-v1', {
      executionMode: 'authoritative',
      blockingEligible: false,
    });

    const stored = await cacheService.setSearchResponse(mockPlan, mockRequest, nonBlockingResponse);

    expect(stored).toBe(false);
    expect(await queryCache.get(buildPlanCacheKey(mockPlan, mockRequest))).toBeUndefined();
  });

  it.each([
    ['ambiguous', createMockResponse('test-v1', { decisionStatus: 'ambiguous' }), 60],
    ['failed', createMockResponse('test-v1', { decisionStatus: 'failed' }), 30],
  ])('caps TTL for %s responses', async (_status, response, maxTtl) => {
    const ttl = await captureQueryCacheTtl(response);
    expect(ttl).toBeLessThanOrEqual(maxTtl);
  });

  it('uses shorter TTL for ambiguous responses than for resolved ones', async () => {
    const ambiguousTtl = await captureQueryCacheTtl(
      createMockResponse('test-v1', { decisionStatus: 'ambiguous' }),
    );
    const resolvedTtl = await captureQueryCacheTtl(createMockResponse('test-v1'));

    expect(ambiguousTtl).toBeLessThan(resolvedTtl);
  });
});
