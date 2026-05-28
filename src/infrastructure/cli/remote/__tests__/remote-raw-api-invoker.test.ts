import { describe, expect, it } from 'vitest';
import { RemoteRawApiInvoker } from '../remote-raw-api-invoker.js';
import type { ResolvedCliProfile } from '../../../../application/cli/context/cli-profile.js';

const profile: ResolvedCliProfile = {
  name: 'test',
  target: 'remote',
  baseUrl: 'https://api.example.com',
  authMode: 'none',
  outputFormat: 'json',
};

interface Captured {
  input: string;
  init: RequestInit | undefined;
}

function makeFetch(
  captured: Captured[],
  responseBody: string,
  responseInit: ResponseInit = { status: 200, headers: { 'content-type': 'application/json' } },
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    captured.push({ input, init });
    return new Response(responseBody, responseInit);
  };
}

describe('RemoteRawApiInvoker', () => {
  it('issues a GET to <baseUrl>/<path> with method uppercased', async () => {
    const captured: Captured[] = [];
    const invoker = new RemoteRawApiInvoker(profile, {
      fetchImpl: makeFetch(captured, '{"ok":true}'),
    });

    await invoker.call({ method: 'get', path: '/health' }, { requestId: 'req-1' });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.input).toBe('https://api.example.com/health');
    expect(captured[0]?.init?.method).toBe('GET');
  });

  it('sends rawBody verbatim and threads content-type for POST', async () => {
    const captured: Captured[] = [];
    const invoker = new RemoteRawApiInvoker(profile, {
      fetchImpl: makeFetch(captured, '{}'),
    });

    await invoker.call(
      {
        method: 'POST',
        path: '/v1/search',
        bodyText: '{"q":"x"}',
        contentType: 'application/json',
      },
      { requestId: 'req-2' },
    );

    expect(captured[0]?.init?.method).toBe('POST');
    expect(captured[0]?.init?.body).toBe('{"q":"x"}');
    const headers = captured[0]?.init?.headers as Headers;
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('propagates custom headers onto the request', async () => {
    const captured: Captured[] = [];
    const invoker = new RemoteRawApiInvoker(profile, {
      fetchImpl: makeFetch(captured, '{}'),
    });

    await invoker.call(
      {
        method: 'GET',
        path: '/health',
        headers: [{ name: 'x-debug', value: 'on' }],
      },
      { requestId: 'req-3' },
    );

    const headers = captured[0]?.init?.headers as Headers;
    expect(headers.get('x-debug')).toBe('on');
  });

  it('appends query params to the path as ?k=v', async () => {
    const captured: Captured[] = [];
    const invoker = new RemoteRawApiInvoker(profile, {
      fetchImpl: makeFetch(captured, '{}'),
    });

    await invoker.call(
      {
        method: 'GET',
        path: '/health',
        query: [{ name: 'k', value: 'v' }],
      },
      { requestId: 'req-4' },
    );

    expect(captured[0]?.input).toContain('?k=v');
  });

  it('returns status / statusText / headers / body / rawText for a non-empty response', async () => {
    const captured: Captured[] = [];
    const invoker = new RemoteRawApiInvoker(profile, {
      fetchImpl: makeFetch(captured, '{"ok":true}'),
    });

    const result = await invoker.call(
      { method: 'GET', path: '/health' },
      { requestId: 'req-5' },
    );

    expect(result.status).toBe(200);
    expect(typeof result.statusText).toBe('string');
    expect(result.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(result.body).toEqual({ ok: true });
    expect(result.rawText).toBe('{"ok":true}');
  });

  it('openApi() issues GET to /openapi.json and returns the parsed document', async () => {
    const captured: Captured[] = [];
    const document = { openapi: '3.1.0', paths: {} };
    const invoker = new RemoteRawApiInvoker(profile, {
      fetchImpl: makeFetch(captured, JSON.stringify(document)),
    });

    const result = await invoker.openApi({ requestId: 'req-6' });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.input).toBe('https://api.example.com/openapi.json');
    expect(captured[0]?.init?.method).toBe('GET');
    expect(result.path).toBe('/openapi.json');
    expect(result.document).toEqual(document);
  });
});
