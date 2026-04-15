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
  createMockCompiledQuery,
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
    compiled = createMockCompiledQuery(),
  ): Promise<{
    readonly plan: QueryPlanV1;
    readonly request: { sessionContext?: { sessionId: string }; context?: { locale: string } };
    readonly compiled: ReturnType<typeof createMockCompiledQuery>;
  }> {
    const plan = createMockPlan();
    await cacheService.setSearchResponse(plan, request, response, compiled);
    return { plan, request, compiled };
  }

  async function captureQueryCacheTtl(
    response: SearchResponseV1,
  ): Promise<number> {
    const plan = createMockPlan();
    const request = {};
    const compiled = createMockCompiledQuery();

    let capturedTtl = 0;
    const delegateCache = new MockQueryCache();
    const spyCache: QueryCachePort = {
      get: (k) => delegateCache.get(k),
      getWithDiagnostics: (k) => delegateCache.getWithDiagnostics(k),
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

    await spyService.setSearchResponse(plan, request, response, compiled);
    return capturedTtl;
  }

  async function seedDirectCachedResponse(
    response: SearchResponseV1,
    request: { sessionContext?: { sessionId: string }; context?: { locale: string } } = {},
    currentSnapshot: DecisionSnapshot = createMockSnapshot(),
    compiled = createMockCompiledQuery(),
  ) {
    const plan = createMockPlan();
    await queryCache.set(buildPlanCacheKey(plan, request, currentSnapshot.snapshot_id), response, 3600);
    return { plan, request, compiled };
  }

  async function expectCacheBypass(
    response: SearchResponseV1,
    options: {
      snapshot?: DecisionSnapshot;
      runtimeState?: ReturnType<typeof authoritativeRuntimeState>;
      request?: { sessionContext?: { sessionId: string }; context?: { locale: string } };
    } = {},
  ) {
    const currentSnapshot = options.snapshot ?? createMockSnapshot();
    const { plan, request, compiled } = await seedDirectCachedResponse(
      response,
      options.request,
      currentSnapshot,
    );
    const result = await cacheService.getSearchResponse(
      plan,
      request,
      currentSnapshot,
      options.runtimeState,
      compiled,
    );
    expect(result.kind).toBe('miss');
    return { result, plan, request };
  }

  it('returns cache miss when no entry exists', async () => {
    const result = await cacheService.getSearchResponse(createMockPlan(), {}, createMockSnapshot());

    expect(result.kind).toBe('miss');
  });

  it('returns cache hit with fresh data', async () => {
    const mockPlan = createMockPlan();
    const mockRequest = {};
    const mockSnapshot = createMockSnapshot();
    const mockResponse = createMockResponse();
    const mockCompiled = createMockCompiledQuery();

    await cacheService.setSearchResponse(mockPlan, mockRequest, mockResponse, mockCompiled);

    const result = await cacheService.getSearchResponse(mockPlan, mockRequest, mockSnapshot, {
      learningKillSwitchEnabled: false,
      denseRetrievalEnabled: true,
      rerankerAvailable: true,
      currentExecutionModeHint: 'authoritative',
    }, mockCompiled);

    expect(result.kind).toBe('hit');
    if (result.kind === 'hit') {
      expect(result.value.meta.requestId).toBe('test-request-123');
    }
  });

  it('refuses caching heuristic responses even on cacheable routes', async () => {
    const mockPlan = createMockPlan();
    const mockRequest = {};
    const mockResponse = createMockResponse('test-v1', {
      executionMode: 'heuristic',
      blockingEligible: false,
      degradationReasons: ['heuristic_drinking_window'],
    });
    const mockCompiled = createMockCompiledQuery();

    await expect(
      cacheService.setSearchResponse(mockPlan, mockRequest, mockResponse, mockCompiled),
    ).resolves.toBe(false);

    const result = await cacheService.getSearchResponse(
      mockPlan,
      mockRequest,
      createMockSnapshot(),
      authoritativeRuntimeState(),
      mockCompiled,
    );
    expect(result.kind).toBe('miss');
  });

  it('invalidates stale entries with version mismatch', async () => {
    const { result } = await expectCacheBypass(
      createMockResponse('old-model-v1'),
      { snapshot: createMockSnapshot('new-model-v2') },
    );
    expect(result.kind).toBe('miss');
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
    const { result } = await expectCacheBypass(createMockResponse(), {
      snapshot: currentSnapshot,
    });
    expect(result.kind).toBe('miss');
  });

  it('bypasses degraded cached entries even when the key matches', async () => {
    const { result } = await expectCacheBypass(createMockResponse('test-v1', {
      executionMode: 'degraded',
      blockingEligible: false,
      degradationReasons: ['reranker_unavailable'],
    }));
    expect(result.kind).toBe('miss');
  });

  it('bypasses contract-version drift with a stable reason', async () => {
    const { result } = await expectCacheBypass(createMockResponse('test-v1', {
      contractVersion: 'search_response_v0',
    }));
    expect(result.kind).toBe('miss');
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
    ],
    [
      'dense retrieval is disabled at runtime',
      {
        learningKillSwitchEnabled: false,
        denseRetrievalEnabled: false,
        rerankerAvailable: true,
        currentExecutionModeHint: 'degraded' as const,
      },
    ],
    [
      'reranker is unavailable at runtime',
      {
        learningKillSwitchEnabled: false,
        denseRetrievalEnabled: true,
        rerankerAvailable: false,
        currentExecutionModeHint: 'degraded' as const,
      },
    ],
  ])('bypasses cache hits when %s', async (_label, runtimeState) => {
    const { plan, request, compiled } = await seedFreshCachedResponse();

    const result = await cacheService.getSearchResponse(
      plan,
      request,
      createMockSnapshot(),
      runtimeState,
      compiled,
    );

    expect(result.kind).toBe('miss');
    expect(
      (
        await queryCache.get(
          buildPlanCacheKey(plan, request, createMockSnapshot().snapshot_id),
        )
      )?.meta.requestId,
    ).toBe('test-request-123');
  });

  it('fails closed when cached model versions are missing', async () => {
    const response = createMockResponse('test-v1');
    const snapshotWithoutModels: DecisionSnapshot = {
      ...response.meta.decisionSnapshot!,
      model_versions: {},
    };
    response.meta.decisionSnapshot = snapshotWithoutModels;
    response.engineDecision.decisionSnapshot = snapshotWithoutModels;

    const { result } = await expectCacheBypass(response, {
      runtimeState: authoritativeRuntimeState(),
    });
    expect(result.kind).toBe('miss');
  });

  it('refuses to write non-blocking-eligible responses to cache', async () => {
    const mockPlan = createMockPlan();
    const mockRequest = {};
    const nonBlockingResponse = createMockResponse('test-v1', {
      executionMode: 'authoritative',
      blockingEligible: false,
    });
    const mockCompiled = createMockCompiledQuery();

    const stored = await cacheService.setSearchResponse(
      mockPlan,
      mockRequest,
      nonBlockingResponse,
      mockCompiled,
    );
    expect(stored).toBe(false);
    expect(
      await queryCache.get(
        buildPlanCacheKey(
          mockPlan,
          mockRequest,
          nonBlockingResponse.meta.decisionSnapshot?.snapshot_id,
        ),
      ),
    ).toBeUndefined();
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
