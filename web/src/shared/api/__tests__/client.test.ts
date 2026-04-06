import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from '../client';

describe('api client', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(response: Partial<Response> & { headers?: Record<string, string> }, body?: unknown) {
    const headerMap = response.headers ?? {};
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? 'OK',
      headers: {
        get: (key: string) => headerMap[key.toLowerCase()] ?? null,
      },
      json: () => Promise.resolve(body),
    });
  }

  describe('search', () => {
    it('sends POST to /v1/search with body', async () => {
      const mockResponse = { query_type: 'search', results: [] };
      mockFetch({ ok: true, status: 200 }, mockResponse);

      const result = await api.search({ query: 'red wine' });
      expect(result).toEqual(mockResponse);

      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/v1/search');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ query: 'red wine' });
    });

    it('throws ApiError on non-OK response', async () => {
      mockFetch(
        { ok: false, status: 400, statusText: 'Bad Request' },
        { error: { code: 'VALIDATION', message: 'Query too short', retryable: false } },
      );

      await expect(api.search({ query: '' })).rejects.toThrow(ApiError);
      try {
        await api.search({ query: '' });
      } catch (e) {
        const err = e as ApiError;
        expect(err.status).toBe(400);
        expect(err.code).toBe('VALIDATION');
        expect(err.retryable).toBe(false);
      }
    });

    it('marks 5xx errors as retryable', async () => {
      mockFetch(
        { ok: false, status: 503, statusText: 'Service Unavailable' },
        {},
      );

      try {
        await api.search({ query: 'test' });
      } catch (e) {
        const err = e as ApiError;
        expect(err.status).toBe(503);
        expect(err.retryable).toBe(true);
      }
    });

    it('exposes Retry-After as retryAfterMs on 429', async () => {
      mockFetch(
        { ok: false, status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '5' } },
        { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Rate limited', retryable: true } },
      );

      try {
        await api.search({ query: 'test' });
      } catch (e) {
        const err = e as ApiError;
        expect(err.status).toBe(429);
        expect(err.retryAfterMs).toBe(5000);
      }
    });
  });

  describe('submitFeedback', () => {
    it('sends POST to /v1/feedback', async () => {
      mockFetch({ ok: true, status: 201 }, { signal_id: 'sig-1', accepted: true });

      const result = await api.submitFeedback({
        query: 'wine',
        entity_id: 'wine:1',
        signal_type: 'click',
        session_id: 'sess-1',
      });
      expect(result.accepted).toBe(true);
    });
  });

  describe('watchlist', () => {
    it('delete returns void on 204', async () => {
      mockFetch({ ok: true, status: 204 });

      const result = await api.watchlist.delete('wl-1');
      expect(result).toBeUndefined();
    });

    it('injects X-Authenticated-Subject header', async () => {
      mockFetch({ ok: true, status: 200 }, { entries: [], total: 0 });

      await api.watchlist.list();

      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(options.headers['X-Authenticated-Subject']).toBeDefined();
      expect(typeof options.headers['X-Authenticated-Subject']).toBe('string');
    });
  });

  describe('health', () => {
    it('calls /health endpoint', async () => {
      mockFetch({ ok: true, status: 200 }, { status: 'ok', timestamp: '2026-01-01T00:00:00Z', uptime: 10 });

      const result = await api.health.check();
      expect(result.status).toBe('ok');

      const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(url).toContain('/health');
    });
  });

  describe('error handling', () => {
    it('handles unparseable error body', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        headers: { get: () => null },
        json: () => Promise.reject(new Error('not JSON')),
      });

      try {
        await api.search({ query: 'test' });
      } catch (e) {
        const err = e as ApiError;
        expect(err.status).toBe(500);
        expect(err.code).toBe('HTTP_500');
      }
    });
  });
});
