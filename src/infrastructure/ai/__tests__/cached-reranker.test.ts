import { describe, expect, it, vi } from 'vitest';
import type { RerankerPort, RerankCandidate } from '../../../domain/ranking/port/reranker.port.js';
import { CachedReranker } from '../cached-reranker.js';
import type { RedisClient } from '../../db/redis-client.js';

function makeCandidates(): readonly RerankCandidate[] {
  return [
    { entityId: 'wine-1' as never, text: 'wine one' },
    { entityId: 'wine-2' as never, text: 'wine two' },
  ];
}

describe('CachedReranker', () => {
  it('memoizes identical rerank requests in memory', async () => {
    const inner: RerankerPort = {
      rerank: vi.fn().mockResolvedValue([
        { entityId: 'wine-1' as never, score: 0.9, rank: 1 },
        { entityId: 'wine-2' as never, score: 0.4, rank: 2 },
      ]),
    };
    const reranker = new CachedReranker({
      modelId: 'rerank-v4.0-pro',
      inner,
    });

    const first = await reranker.rerank('pinot grigio', makeCandidates(), 2);
    const second = await reranker.rerank('pinot grigio', makeCandidates(), 2);

    expect(first).toEqual(second);
    expect(inner.rerank).toHaveBeenCalledTimes(1);
  });

  it('treats different limits as distinct cache keys', async () => {
    const inner: RerankerPort = {
      rerank: vi.fn().mockResolvedValue([
        { entityId: 'wine-1' as never, score: 0.9, rank: 1 },
      ]),
    };
    const reranker = new CachedReranker({
      modelId: 'rerank-v4.0-pro',
      inner,
    });

    await reranker.rerank('pinot grigio', makeCandidates(), 1);
    await reranker.rerank('pinot grigio', makeCandidates(), 2);

    expect(inner.rerank).toHaveBeenCalledTimes(2);
  });

  it('treats different models as distinct cache namespaces', async () => {
    const inner: RerankerPort = {
      rerank: vi.fn().mockResolvedValue([
        { entityId: 'wine-1' as never, score: 0.9, rank: 1 },
      ]),
    };
    const cachedA = new CachedReranker({ modelId: 'rerank-a', inner });
    const cachedB = new CachedReranker({ modelId: 'rerank-b', inner });

    await cachedA.rerank('pinot grigio', makeCandidates(), 1);
    await cachedB.rerank('pinot grigio', makeCandidates(), 1);

    expect(inner.rerank).toHaveBeenCalledTimes(2);
  });

  it('uses redis-backed cache when redis is provided', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify([{ entityId: 'wine-1', score: 0.9, rank: 1 }]));
    const set = vi.fn().mockResolvedValue('OK');
    const incr = vi.fn().mockResolvedValue(1);
    const del = vi.fn().mockResolvedValue(1);
    const redis = {
      get,
      set,
      incr,
      del,
    } as unknown as RedisClient;

    const inner: RerankerPort = {
      rerank: vi.fn().mockResolvedValue([
        { entityId: 'wine-1' as never, score: 0.9, rank: 1 },
      ]),
    };
    const reranker = new CachedReranker({
      modelId: 'rerank-v4.0-pro',
      inner,
      redis,
    });

    await reranker.rerank('pinot grigio', makeCandidates(), 1);
    await reranker.rerank('pinot grigio', makeCandidates(), 1);

    expect(inner.rerank).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
  });
});
