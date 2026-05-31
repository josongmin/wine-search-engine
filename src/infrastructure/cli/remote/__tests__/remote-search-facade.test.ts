import { describe, expect, it } from 'vitest';
import { RemoteSearchFacade } from '../remote-search-facade.js';

describe('RemoteSearchFacade', () => {
  it('posts the primitive search body to /v1/search/hybrid', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const facade = new RemoteSearchFacade(
      {
        name: 'staging',
        target: 'remote',
        baseUrl: 'https://api.example.com',
        authMode: 'none',
        outputFormat: 'json',
      },
      {
        fetchImpl: async (input, init) => {
          calls.push({ input, init });
          return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    );

    const result = await facade.hybrid({ query: 'opus one 2018' }, { requestId: 'req-1' });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/search/hybrid');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toBeInstanceOf(Headers);
    const body = calls[0]?.init?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual({
      query: 'opus one 2018',
    });
  });
});
