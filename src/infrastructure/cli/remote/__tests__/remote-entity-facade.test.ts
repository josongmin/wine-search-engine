import { describe, expect, it } from 'vitest';
import { RemoteEntityFacade } from '../remote-entity-facade.js';
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
  responseBody: unknown,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    captured.push({ input, init });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('RemoteEntityFacade', () => {
  it('POSTs query to /v1/entity/resolve and returns parsed JSON', async () => {
    const captured: Captured[] = [];
    const wire = { status: 'resolved', candidates: [] };
    const facade = new RemoteEntityFacade(profile, { fetchImpl: makeFetch(captured, wire) });

    const result = await facade.resolve({ query: 'q' }, { requestId: 'req-1' });

    expect(result).toEqual(wire);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.input.endsWith('/v1/entity/resolve')).toBe(true);
    expect(captured[0]?.init?.method).toBe('POST');
    const body = captured[0]?.init?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual({ query: 'q' });
  });

  it('POSTs query to /v1/entity/autocomplete and returns parsed JSON', async () => {
    const captured: Captured[] = [];
    const wire = { suggestions: [{ label: 'opus one' }] };
    const facade = new RemoteEntityFacade(profile, { fetchImpl: makeFetch(captured, wire) });

    const result = await facade.autocomplete({ query: 'op' }, { requestId: 'req-2' });

    expect(result).toEqual(wire);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.input.endsWith('/v1/entity/autocomplete')).toBe(true);
    expect(captured[0]?.init?.method).toBe('POST');
    expect(JSON.parse((captured[0]?.init?.body as string) ?? '{}')).toEqual({ query: 'op' });
  });

  it('includes optional context/sessionContext/queryBudget in the body when provided', async () => {
    const captured: Captured[] = [];
    const facade = new RemoteEntityFacade(profile, {
      fetchImpl: makeFetch(captured, { status: 'resolved' }),
    });
    const context = { locale: 'ko-KR' } as never;
    const sessionContext = { sessionId: 's1' } as never;
    const queryBudget = { maxTokens: 1000 } as never;

    await facade.resolve(
      { query: 'q', context, sessionContext, queryBudget },
      { requestId: 'req-3' },
    );

    const body = JSON.parse((captured[0]?.init?.body as string) ?? '{}');
    expect(body).toEqual({ query: 'q', context, sessionContext, queryBudget });
  });

  it('omits optional fields from the body when not provided', async () => {
    const captured: Captured[] = [];
    const facade = new RemoteEntityFacade(profile, {
      fetchImpl: makeFetch(captured, {}),
    });

    await facade.autocomplete({ query: 'q' }, { requestId: 'req-4' });

    const body = JSON.parse((captured[0]?.init?.body as string) ?? '{}');
    expect(Object.keys(body).sort()).toEqual(['query']);
  });
});
