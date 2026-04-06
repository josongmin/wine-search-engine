import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpEmbeddingService } from '../../../src/infrastructure/vespa/embedding-service.js';

describe('HttpEmbeddingService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the configured model and returns embeddings ordered by index', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        object: 'list',
        data: [
          { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
          { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
        ],
        model: 'bge-m3-test',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = new HttpEmbeddingService({
      url: 'http://embedding.local',
      model: 'bge-m3-test',
    });

    const result = await service.embedBatch(['first', 'second']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://embedding.local/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'bge-m3-test',
          input: ['first', 'second'],
        }),
      }),
    );
  });

  it('embed returns the first embedding for a single input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.9, 0.1] }],
          model: 'bge-m3-test',
        }),
      }),
    );

    const service = new HttpEmbeddingService({
      url: 'http://embedding.local',
      model: 'bge-m3-test',
    });

    await expect(service.embed('query')).resolves.toEqual([0.9, 0.1]);
  });

  it('throws a descriptive error on non-2xx responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'upstream unavailable',
      }),
    );

    const service = new HttpEmbeddingService({
      url: 'http://embedding.local',
      model: 'bge-m3-test',
    });

    await expect(service.embed('query')).rejects.toThrow(
      'Embedding service call failed [HTTP 503]: upstream unavailable',
    );
  });

  it('rejects malformed API payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ not_data: true }),
      }),
    );

    const service = new HttpEmbeddingService({
      url: 'http://embedding.local',
      model: 'bge-m3-test',
    });

    await expect(service.embed('query')).rejects.toThrow(
      'Embedding service: unexpected response shape',
    );
  });
});
