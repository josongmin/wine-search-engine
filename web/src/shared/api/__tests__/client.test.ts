import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from '../client';

interface MockFetchResponse {
  readonly ok?: boolean;
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: Record<string, string>;
}

describe('api client', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(response: MockFetchResponse, body?: unknown) {
    const headerMap: Record<string, string> = response.headers ?? {};
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

  describe('wineSearch', () => {
    it('execute sends POST to /v1/wine-search with body', async () => {
      mockFetch(
        { ok: true, status: 200 },
        {
          query_type: 'wine_search',
          answer: '레드 와인 추천 결과입니다',
          execution: {
            steps: [],
            tool_call_count: 0,
          },
          meta: {
            request_id: 'r1',
            total_duration_ms: 1,
            total_tokens: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
            },
            intent: 'search',
            plan_kind: 'single-search',
            termination: { reason: 'answer', layer: 'primary' },
            policy_blocked: false,
          },
        },
      );

      const res = await api.wineSearch.execute({ query: '레드 와인 추천해줘' });
      expect(res.query_type).toBe('wine_search');
      expect(res.meta.intent).toBe('search');
      expect(res.meta.plan_kind).toBe('single-search');
      expect(res.meta.policy_blocked).toBe(false);

      const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(url)).toContain('/v1/wine-search');
      expect(options.method).toBe('POST');
      expect(JSON.parse(options.body)).toEqual({ query: '레드 와인 추천해줘' });
    });

    it('forwards options.max_steps in the request body', async () => {
      mockFetch(
        { ok: true, status: 200 },
        {
          query_type: 'wine_search',
          answer: 'x',
          execution: { steps: [], tool_call_count: 0 },
          meta: {
            request_id: 'r2',
            total_duration_ms: 0,
            total_tokens: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_creation_tokens: 0,
            },
            intent: 'search',
            plan_kind: 'single-search',
            termination: { reason: 'answer', layer: 'primary' },
            policy_blocked: false,
          },
        },
      );

      await api.wineSearch.execute({ query: 'x', options: { max_steps: 7 } });
      const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(options.body)).toEqual({ query: 'x', options: { max_steps: 7 } });
    });

    it('throws ApiError on non-OK wine-search response', async () => {
      mockFetch(
        { ok: false, status: 400, statusText: 'Bad Request' },
        { error: { code: 'VALIDATION', message: 'query empty', retryable: false } },
      );
      try {
        await api.wineSearch.execute({ query: '' });
      } catch (e) {
        const err = e as ApiError;
        expect(err.status).toBe(400);
        expect(err.code).toBe('VALIDATION');
      }
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
