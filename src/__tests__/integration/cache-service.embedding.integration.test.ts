import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('treats empty cached embedding vector as cache miss', async () => {
    const texts = ['hello world'];
    // Store an empty vector in cache — this should be treated as a miss
    await embeddingCache.set(embeddingLookupKey(texts[0]!, 'test-model'), [], 7200);

    const mockEmbeddingService = createMockEmbeddingService();

    const result = await cacheService.getOrEmbedBatch(
      texts,
      'test-model',
      mockEmbeddingService,
    );

    // Should have called embedding service since empty vector is a miss
    expect(mockEmbeddingService.embedBatch).toHaveBeenCalledWith(['hello world']);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(createEmbeddingVector(0.1));
  });

  it('skips null embeddings returned by the embedding service (not cached, not used)', async () => {
    const texts = ['hello world', 'bad text'];
    // Embedding service returns null for the second text
    const mockEmbeddingService = {
      embedBatch: vi.fn(async (_txts: readonly string[]): Promise<readonly (readonly number[] | null)[]> => [
        createEmbeddingVector(0.1),
        null as unknown as readonly number[],
      ]),
    };

    const result = await cacheService.getOrEmbedBatch(
      texts,
      'test-model',
      mockEmbeddingService,
    );

    expect(result).toHaveLength(2);
    // First embedding is valid
    expect(result[0]).toEqual(createEmbeddingVector(0.1));
    // Second embedding stays null — null embedding is not stored in cache
    expect(result[1]).toBeNull();

    // Verify the null embedding was NOT cached
    const cached = await embeddingCache.get(embeddingLookupKey('bad text', 'test-model'));
    expect(cached).toBeUndefined();
  });

  it('skips empty-array embeddings returned by the embedding service (truthy but useless)', async () => {
    const texts = ['hello world', 'empty text'];
    // Embedding service returns empty array for the second text
    const mockEmbeddingService = {
      embedBatch: vi.fn(async (_txts: readonly string[]): Promise<readonly (readonly number[])[]> => [
        createEmbeddingVector(0.1),
        [], // empty array — truthy but useless
      ]),
    };

    const result = await cacheService.getOrEmbedBatch(
      texts,
      'test-model',
      mockEmbeddingService,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(createEmbeddingVector(0.1));
    // Empty embedding stays null — the guard `embedding.length > 0` rejects it
    expect(result[1]).toBeNull();

    // Verify the empty embedding was NOT cached
    const cached = await embeddingCache.get(embeddingLookupKey('empty text', 'test-model'));
    expect(cached).toBeUndefined();
  });

  it('caches and uses valid embeddings returned by the embedding service', async () => {
    const texts = ['valid text'];
    const validEmbedding = createEmbeddingVector(0.3);
    const mockEmbeddingService = {
      embedBatch: vi.fn(async (_txts: readonly string[]): Promise<readonly (readonly number[])[]> => [
        validEmbedding,
      ]),
    };

    const result = await cacheService.getOrEmbedBatch(
      texts,
      'test-model',
      mockEmbeddingService,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(validEmbedding);

    // Wait for async cache write to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify the valid embedding WAS cached
    const cached = await embeddingCache.get(embeddingLookupKey('valid text', 'test-model'));
    expect(cached).toEqual(validEmbedding);
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
