import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpCrossEncoderReranker } from '../../../src/infrastructure/vespa/reranker.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import type { RerankCandidate } from '../../../src/domain/ranking/port/reranker.port.js';

function makeCandidate(entityId: string, text: string): RerankCandidate {
  return {
    entityId: createEntityId(entityId),
    text,
  };
}

describe('HttpCrossEncoderReranker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts query/texts and sorts rerank outputs by score descending', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, score: 0.42 },
          { index: 0, score: 0.91 },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const reranker = new HttpCrossEncoderReranker({
      url: 'http://reranker.local',
    });
    const candidates = [
      makeCandidate('wine-opus-one', 'Opus One 2018'),
      makeCandidate('wine-moet', 'Moet Brut NV'),
    ];

    const results = await reranker.rerank('luxury wine', candidates, 2);

    expect(results).toEqual([
      { entityId: createEntityId('wine-opus-one'), score: 0.91, rank: 1 },
      { entityId: createEntityId('wine-moet'), score: 0.42, rank: 2 },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://reranker.local/rerank',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'luxury wine',
          texts: ['Opus One 2018', 'Moet Brut NV'],
        }),
      }),
    );
  });

  it('returns an empty array when there are no candidates', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const reranker = new HttpCrossEncoderReranker({
      url: 'http://reranker.local',
    });

    await expect(reranker.rerank('wine', [], 5)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a descriptive error on upstream failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => 'bad gateway',
      }),
    );

    const reranker = new HttpCrossEncoderReranker({
      url: 'http://reranker.local',
    });

    await expect(
      reranker.rerank('wine', [makeCandidate('wine-opus-one', 'Opus One 2018')], 1),
    ).rejects.toThrow('Reranker service call failed [HTTP 502]: bad gateway');
  });

  it('rejects malformed reranker payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ nope: true }),
      }),
    );

    const reranker = new HttpCrossEncoderReranker({
      url: 'http://reranker.local',
    });

    await expect(
      reranker.rerank('wine', [makeCandidate('wine-opus-one', 'Opus One 2018')], 1),
    ).rejects.toThrow('Reranker service: unexpected response shape');
  });
});
