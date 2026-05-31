import { describe, expect, it } from 'vitest';
import { RemoteAgentFacade } from '../remote-agent-facade.js';
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

describe('RemoteAgentFacade', () => {
  it('POSTs body { messages } to /v1/agent when no tunable fields are provided', async () => {
    const captured: Captured[] = [];
    const facade = new RemoteAgentFacade(profile, {
      fetchImpl: makeFetch(captured, { answer: 'ok' }),
    });

    await facade.run({ messages: [{ role: 'user', content: 'q' }] }, { requestId: 'req-1' });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.input.endsWith('/v1/agent')).toBe(true);
    expect(captured[0]?.init?.method).toBe('POST');
    const body = JSON.parse((captured[0]?.init?.body as string) ?? '{}');
    expect(body).toEqual({ messages: [{ role: 'user', content: 'q' }] });
    expect(Object.keys(body)).not.toContain('options');
  });

  it('POSTs body with snake_case options when tunable fields are provided', async () => {
    const captured: Captured[] = [];
    const facade = new RemoteAgentFacade(profile, {
      fetchImpl: makeFetch(captured, { answer: 'ok' }),
    });

    await facade.run(
      {
        messages: [{ role: 'user', content: 'q' }],
        options: { maxSteps: 5, perStepTimeoutMs: 2000 },
      },
      { requestId: 'req-2' },
    );

    const body = JSON.parse((captured[0]?.init?.body as string) ?? '{}');
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'q' }],
      options: { max_steps: 5, per_step_timeout_ms: 2000 },
    });
  });

  it('emits agent_timeout_ms and max_total_tokens snake_case keys in options when provided', async () => {
    const captured: Captured[] = [];
    const facade = new RemoteAgentFacade(profile, {
      fetchImpl: makeFetch(captured, { answer: 'ok' }),
    });

    await facade.run(
      {
        messages: [{ role: 'user', content: 'q' }],
        options: { agentTimeoutMs: 10000, maxTotalTokens: 30000 },
      },
      { requestId: 'req-3' },
    );

    const body = JSON.parse((captured[0]?.init?.body as string) ?? '{}');
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'q' }],
      options: { agent_timeout_ms: 10000, max_total_tokens: 30000 },
    });
  });

  it('returns the parsed JSON wire response unchanged', async () => {
    const captured: Captured[] = [];
    const wire = { answer: 'an answer', meta: { request_id: 'req-4' } };
    const facade = new RemoteAgentFacade(profile, {
      fetchImpl: makeFetch(captured, wire),
    });

    const result = await facade.run(
      { messages: [{ role: 'user', content: 'q' }] },
      { requestId: 'req-4' },
    );

    expect(result).toEqual(wire);
  });

  it('POSTs session start to /v1/agent/sessions', async () => {
    const captured: Captured[] = [];
    const facade = new RemoteAgentFacade(profile, {
      fetchImpl: makeFetch(captured, { session_id: 'sess_1' }),
    });

    await facade.startSession(
      { clientSessionId: 'client-1', options: { maxSteps: 4 } },
      { requestId: 'req-5' },
    );

    expect(captured[0]?.input.endsWith('/v1/agent/sessions')).toBe(true);
    expect(JSON.parse((captured[0]?.init?.body as string) ?? '{}')).toEqual({
      client_session_id: 'client-1',
      options: { max_steps: 4 },
    });
  });

  it('POSTs session turn to /v1/agent/sessions/:id/turns', async () => {
    const captured: Captured[] = [];
    const facade = new RemoteAgentFacade(profile, {
      fetchImpl: makeFetch(captured, { answer: 'continued' }),
    });

    await facade.turnSession(
      {
        sessionId: 'sess/1',
        clientTurnId: 'turn-1',
        messages: [{ role: 'user', content: 'follow up' }],
        expectedSessionVersion: 2,
      },
      { requestId: 'req-6' },
    );

    expect(captured[0]?.input.endsWith('/v1/agent/sessions/sess%2F1/turns')).toBe(true);
    expect(JSON.parse((captured[0]?.init?.body as string) ?? '{}')).toEqual({
      client_turn_id: 'turn-1',
      messages: [{ role: 'user', content: 'follow up' }],
      expected_session_version: 2,
    });
  });
});
