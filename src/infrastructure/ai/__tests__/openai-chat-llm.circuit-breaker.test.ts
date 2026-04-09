/**
 * Circuit-breaker wiring tests for OpenAiChatLlm.
 *
 * Mirrors anthropic-chat-llm.circuit-breaker.test.ts: validates that the
 * breaker trips on 5 consecutive service-health failures, fast-fails the
 * next call, and remains CLOSED on repeated 4xx (non-429) caller faults.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerOpenError } from '../../../domain/shared/error/circuit-breaker-open-error.js';
import { OpenAiChatLlm } from '../openai-chat-llm.js';

function successBody(content = 'hi'): string {
  return JSON.stringify({
    model: 'gpt-4o-mini',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content },
      },
    ],
  });
}

function newAdapter(): OpenAiChatLlm {
  return new OpenAiChatLlm({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    defaultModel: 'gpt-4o-mini',
    httpTimeoutMs: 60_000,
  });
}

async function runCompleteIgnoringError(llm: OpenAiChatLlm): Promise<unknown> {
  try {
    return await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (err) {
    return err;
  }
}

describe('OpenAiChatLlm circuit breaker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stays CLOSED on normal successful calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(successBody('ok'), { status: 200 })),
    );

    const llm = newAdapter();
    const r1 = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const r2 = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r1.text).toBe('ok');
    expect(r2.text).toBe('ok');
  });

  it('opens after 5 consecutive 5xx failures and fast-fails the next call', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const llm = newAdapter();

    for (let i = 0; i < 5; i++) {
      const p = runCompleteIgnoringError(llm);
      await vi.advanceTimersByTimeAsync(30_000);
      const err = await p;
      expect(err).toBeInstanceOf(Error);
    }

    const callsBefore = fetchMock.mock.calls.length;
    const err = await runCompleteIgnoringError(llm);
    expect(err).toBeInstanceOf(CircuitBreakerOpenError);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('does NOT open on repeated 4xx (non-429) errors — caller fault', async () => {
    const fetchMock = vi.fn(async () => new Response('bad body', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const llm = newAdapter();

    for (let i = 0; i < 10; i++) {
      const err = await runCompleteIgnoringError(llm);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CircuitBreakerOpenError);
      expect((err as Error).message).toMatch(/400/);
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(10);
  });
});
