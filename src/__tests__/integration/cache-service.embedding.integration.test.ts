import { beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from '../../domain/performance/index.js';
import type { EmbeddingCachePort } from '../../domain/performance/port/embedding-cache.port.js';
import {
  MockEmbeddingCache,
  MockQueryCache,
  createEmbeddingVector,
  createMockEmbeddingService,
  embeddingLookupKey,
  emptyCacheStats,
} from './helpers/cache-service-test-helpers.js';

describe('CacheService embedding cache integration', () => {
  let cacheService: CacheService;
  let queryCache: MockQueryCache;
  let embeddingCache: MockEmbeddingCache;

  beforeEach(() => {
    queryCache = new MockQueryCache();
    embeddingCache = new MockEmbeddingCache();
    cacheService = new CacheService(queryCache, embeddingCache, 5, 60000);
  });

  it('returns embeddings with batch processing', async () => {
    const texts = ['hello world', 'foo bar', 'baz'];
    const mockEmbeddingService = createMockEmbeddingService();

    const result = await cacheService.getOrEmbedBatch(
      texts,
      'test-model',
      mockEmbeddingService,
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(createEmbeddingVector(0.1));
    expect(mockEmbeddingService.embedBatch).toHaveBeenCalled();
  });

  it('reuses cached embeddings and only embeds uncached ones', async () => {
    const texts = ['hello world', 'foo bar', 'baz'] as const;
    const cachedEmbedding = createEmbeddingVector(0.5);

    await embeddingCache.set(embeddingLookupKey(texts[0], 'test-model'), cachedEmbedding, 7200);

    const mockEmbeddingService = createMockEmbeddingService();

    await cacheService.getOrEmbedBatch(texts, 'test-model', mockEmbeddingService);

    expect(mockEmbeddingService.embedBatch).toHaveBeenCalled();
  });

  it('falls back to embedding service on cache service errors', async () => {
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
    const mockEmbeddingService = createMockEmbeddingService();

    const result = await cacheServiceWithError.getOrEmbedBatch(
      texts,
      'test-model',
      mockEmbeddingService,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(createEmbeddingVector(0.1));
  });
});
