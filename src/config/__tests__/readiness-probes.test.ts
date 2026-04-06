import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  probeJsonPostEndpoint,
  withProbeTimeout,
} from '../../infrastructure/health/readiness-probes.js';

describe('readiness probes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns down when a probe times out', async () => {
    const result = await withProbeTimeout(
      async (signal) => new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }),
      10,
    );

    expect(result).toBe('down');
  });

  it('posts JSON payloads and maps successful responses to up', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await probeJsonPostEndpoint('http://localhost:8080/health', {
      ping: true,
    });

    expect(result).toBe('up');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:8080/health',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ping: true }),
      }),
    );
  });

  it('maps 5xx responses to down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { status: 503 })),
    );

    await expect(
      probeJsonPostEndpoint('http://localhost:8080/health', { ping: true }),
    ).resolves.toBe('down');
  });

  it('maps network exceptions to down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    );

    await expect(
      probeJsonPostEndpoint('http://localhost:8080/health', { ping: true }),
    ).resolves.toBe('down');
  });
});
