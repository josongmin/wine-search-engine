import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalEntityId } from '../../../domain/shared/types/index.js';
import { CohereReranker } from '../cohere-reranker.js';

describe('CohereReranker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts Cohere-shaped payload and maps relevance scores', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.73 },
        ],
      }), { status: 200 })),
    );

    const reranker = new CohereReranker({
      baseUrl: 'https://api.cohere.ai/v2',
      apiKey: 'co-test',
      model: 'rerank-v4.0-pro',
      httpTimeoutMs: 5000,
    });

    const results = await reranker.rerank(
      'bourgogne pinot noir',
      [
        { entityId: 'wine_1', text: 'wine one' },
        { entityId: 'wine_2', text: 'wine two' },
      ],
      2,
    );

    expect(results).toEqual([
      { entityId: 'wine_2', score: 0.91, rank: 1 },
      { entityId: 'wine_1', score: 0.73, rank: 2 },
    ]);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.cohere.ai/v2/rerank',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer co-test',
        }),
        body: JSON.stringify({
          model: 'rerank-v4.0-pro',
          query: 'bourgogne pinot noir',
          documents: ['wine one', 'wine two'],
          top_n: 2,
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('throws when a candidate entityId uses the forbidden source-record public namespace (ADR-007)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), {
          status: 200,
        }),
      ),
    );

    const reranker = new CohereReranker({
      baseUrl: 'https://api.cohere.ai/v2',
      apiKey: 'co-test',
      model: 'rerank-v4.0-pro',
      httpTimeoutMs: 5000,
    });

    await expect(
      reranker.rerank(
        'q',
        [{ entityId: 'vivino-bad' as CanonicalEntityId, text: 'x' }],
        1,
      ),
    ).rejects.toThrow(/ADR-007/);
  });

  it('throws on malformed partial Cohere responses instead of dropping bad items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        results: [
          { index: 0, relevance_score: 0.91 },
          { index: 99, relevance_score: 0.73 },
        ],
      }), { status: 200 })),
    );

    const reranker = new CohereReranker({
      baseUrl: 'https://api.cohere.ai/v2',
      apiKey: 'co-test',
      model: 'rerank-v4.0-pro',
      httpTimeoutMs: 5000,
    });

    await expect(
      reranker.rerank(
        'bourgogne pinot noir',
        [
          { entityId: 'wine_1', text: 'wine one' },
          { entityId: 'wine_2', text: 'wine two' },
        ],
        2,
      ),
    ).rejects.toThrow(/out of bounds/);
  });
});
