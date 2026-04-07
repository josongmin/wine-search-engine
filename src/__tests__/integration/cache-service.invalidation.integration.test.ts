import { beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from '../../domain/performance/index.js';
import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import {
  MockEmbeddingCache,
  MockQueryCache,
  buildPlanCacheKey,
  createMockPlan,
  createMockResponse,
  rawEmbeddingKey,
} from './helpers/cache-service-test-helpers.js';

describe('CacheService invalidation integration', () => {
  let cacheService: CacheService;
  let queryCache: MockQueryCache;
  let embeddingCache: MockEmbeddingCache;

  beforeEach(() => {
    queryCache = new MockQueryCache();
    embeddingCache = new MockEmbeddingCache();
    cacheService = new CacheService(queryCache, embeddingCache, 5, 60000);
  });

  it('invalidates embeddings by model ID', async () => {
    await embeddingCache.set(rawEmbeddingKey('embedding:old-model:key1'), [0.1, 0.2], 7200);
    await embeddingCache.set(rawEmbeddingKey('embedding:old-model:key2'), [0.3, 0.4], 7200);
    await embeddingCache.set(rawEmbeddingKey('embedding:new-model:key3'), [0.5, 0.6], 7200);

    await cacheService.invalidateByModel('old-model');

    const oldKey1 = await embeddingCache.get(rawEmbeddingKey('embedding:old-model:key1'));
    const newKey3 = await embeddingCache.get(rawEmbeddingKey('embedding:new-model:key3'));

    expect(oldKey1).toBeUndefined();
    expect(newKey3).toEqual([0.5, 0.6]);
  });

  it('invalidates all query cache entries', async () => {
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
