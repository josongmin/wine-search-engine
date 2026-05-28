import { describe, expect, it } from 'vitest';
import { RemoteHttpClient } from '../remote-http-client.js';
import { CliError } from '../../../../application/cli/command/cli-error.js';
import type { ResolvedCliProfile } from '../../../../application/cli/context/cli-profile.js';

const baseProfile: ResolvedCliProfile = {
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
  response: Response,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    captured.push({ input, init });
    return response;
  };
}

describe('RemoteHttpClient', () => {
  it('requestJson throws CliError(execution) on non-2xx with HTTP <status> in message', async () => {
    // A single Response body can only be read once; call requestJson once and
    // check both instance + shape on the caught error.
    const client = new RemoteHttpClient(baseProfile, {
      fetchImpl: async () =>
        new Response('not found', {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'text/plain' },
        }),
    });

    let caught: unknown;
    try {
      await client.requestJson({ method: 'GET', path: '/missing' }, { requestId: 'req-1' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({
      kind: 'execution',
      message: expect.stringContaining('HTTP 404') as unknown as string,
    });
  });

  it('request throws CliError(usage) when profile.baseUrl is omitted', async () => {
    const profileNoBase: ResolvedCliProfile = {
      name: 'test',
      target: 'remote',
      authMode: 'none',
      outputFormat: 'json',
    };
    const client = new RemoteHttpClient(profileNoBase, {
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });

    await expect(
      client.request({ method: 'GET', path: '/health' }, { requestId: 'req-2' }),
    ).rejects.toBeInstanceOf(CliError);
    await expect(
      client.request({ method: 'GET', path: '/health' }, { requestId: 'req-2' }),
    ).rejects.toMatchObject({ kind: 'usage' });
  });

  it('request throws CliError(usage) when baseUrl is an empty string', async () => {
    const profileEmptyBase: ResolvedCliProfile = {
      name: 'test',
      target: 'remote',
      baseUrl: '   ',
      authMode: 'none',
      outputFormat: 'json',
    };
    const client = new RemoteHttpClient(profileEmptyBase, {
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });

    await expect(
      client.request({ method: 'GET', path: '/health' }, { requestId: 'req-3' }),
    ).rejects.toMatchObject({ kind: 'usage' });
  });

  it('adds accept and x-request-id headers on every request', async () => {
    const captured: Captured[] = [];
    const client = new RemoteHttpClient(baseProfile, {
      fetchImpl: makeFetch(
        captured,
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    });

    await client.request({ method: 'GET', path: '/health' }, { requestId: 'req-4' });

    const headers = captured[0]?.init?.headers as Headers;
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('x-request-id')).toBe('req-4');
  });

  it('adds Authorization: Bearer <token> when authMode=bearer and bearerToken is set', async () => {
    const captured: Captured[] = [];
    const profileBearer: ResolvedCliProfile = {
      ...baseProfile,
      authMode: 'bearer',
      bearerToken: 'tok',
    };
    const client = new RemoteHttpClient(profileBearer, {
      fetchImpl: makeFetch(
        captured,
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    });

    await client.request({ method: 'GET', path: '/health' }, { requestId: 'req-5' });

    const headers = captured[0]?.init?.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer tok');
  });

  it('throws CliError(usage) when authMode=bearer but bearerToken is missing', async () => {
    const profileBearerNoToken: ResolvedCliProfile = {
      ...baseProfile,
      authMode: 'bearer',
    };
    const client = new RemoteHttpClient(profileBearerNoToken, {
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });

    await expect(
      client.request({ method: 'GET', path: '/health' }, { requestId: 'req-6' }),
    ).rejects.toMatchObject({
      kind: 'usage',
      message: expect.stringContaining('requires --bearer-token') as unknown as string,
    });
  });

  it('forwards options.abortSignal into init.signal', async () => {
    const captured: Captured[] = [];
    const client = new RemoteHttpClient(baseProfile, {
      fetchImpl: makeFetch(
        captured,
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    });
    const controller = new AbortController();

    await client.request(
      { method: 'GET', path: '/health' },
      { requestId: 'req-7', abortSignal: controller.signal },
    );

    expect(captured[0]?.init?.signal).toBe(controller.signal);
  });

  it('parses JSON body when content-type includes application/json', async () => {
    const captured: Captured[] = [];
    const client = new RemoteHttpClient(baseProfile, {
      fetchImpl: makeFetch(
        captured,
        new Response('{"x":1}', {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      ),
    });

    const response = await client.request(
      { method: 'GET', path: '/x' },
      { requestId: 'req-8' },
    );

    expect(response.body).toEqual({ x: 1 });
    expect(response.rawText).toBe('{"x":1}');
  });

  it('returns raw text body when content-type is not JSON', async () => {
    const captured: Captured[] = [];
    const client = new RemoteHttpClient(baseProfile, {
      fetchImpl: makeFetch(
        captured,
        new Response('hello world', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    });

    const response = await client.request(
      { method: 'GET', path: '/x' },
      { requestId: 'req-9' },
    );

    expect(response.body).toBe('hello world');
    expect(response.rawText).toBe('hello world');
  });

  it('throws CliError(execution) with cause when content-type is JSON but body is unparseable', async () => {
    const captured: Captured[] = [];
    const client = new RemoteHttpClient(baseProfile, {
      fetchImpl: makeFetch(
        captured,
        new Response('not-json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    });

    let caught: unknown;
    try {
      await client.request({ method: 'GET', path: '/x' }, { requestId: 'req-10' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).kind).toBe('execution');
    expect((caught as CliError).cause).toBeDefined();
  });
});
