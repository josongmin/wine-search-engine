/**
 * Circuit-breaker wiring tests for AnthropicChatLlm.
 *
 * Validates that:
 *   - Normal calls pass through with the breaker staying CLOSED.
 *   - 5 consecutive 5xx failures trip the breaker to OPEN.
 *   - Once OPEN, the next call fast-fails with CircuitBreakerOpenError
 *     without invoking fetch at all.
 *   - 4xx (non-429) errors do NOT trip the breaker — they reflect caller
 *     bugs, not upstream health.
 *
 * We mock `fetch` globally; the adapter goes through `fetchWithTimeout`
 * which delegates to global fetch. Timers are faked so we can advance
 * through the retry backoff without waiting real wall-clock time.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerOpenError } from '../../../domain/shared/error/circuit-breaker-open-error.js';
import { AnthropicChatLlm } from '../anthropic-chat-llm.js';

function successBody(text = 'hi'): string {
  return JSON.stringify({
    id: 'msg_test',
    model: 'claude-test',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
  });
}

function newAdapter(): AnthropicChatLlm {
  return new AnthropicChatLlm({
    apiKey: 'sk-ant-test',
    defaultModel: 'claude-test',
    httpTimeoutMs: 60_000,
  });
}

async function runCompleteIgnoringError(llm: AnthropicChatLlm): Promise<unknown> {
  try {
    return await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
  } catch (err) {
    return err;
  }
}

describe('AnthropicChatLlm circuit breaker', () => {
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
    const r = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('ok');
    // Second call should also succeed — breaker never opened.
    const r2 = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r2.text).toBe('ok');
  });

  it('opens after 5 consecutive 5xx failures and fast-fails the next call', async () => {
    vi.useFakeTimers();
    // Pin jitter to 0 so retry sleeps complete instantly.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const llm = newAdapter();

    // Fire five requests; each exhausts its own retry budget (4 attempts)
    // and surfaces a 503 error to runUnderLlmBreaker → recordFailure.
    for (let i = 0; i < 5; i++) {
      const p = runCompleteIgnoringError(llm);
      await vi.advanceTimersByTimeAsync(30_000);
      const err = await p;
      expect(err).toBeInstanceOf(Error);
    }

    // Breaker should now be OPEN — next call must fast-fail synchronously
    // without hitting fetch again.
    const callsBefore = fetchMock.mock.calls.length;
    const err = await runCompleteIgnoringError(llm);
    expect(err).toBeInstanceOf(CircuitBreakerOpenError);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('does NOT open on repeated 4xx (non-429) errors — caller fault', async () => {
    // 400 Bad Request is a caller bug; the service is healthy.
    const fetchMock = vi.fn(async () => new Response('bad body', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const llm = newAdapter();

    // Fire ten 400-producing calls. If 4xx counted toward the breaker,
    // it would open after 5 and the next call would fast-fail with
    // CircuitBreakerOpenError. We expect the caller to keep seeing the
    // raw 400 error, not a breaker error.
    for (let i = 0; i < 10; i++) {
      const err = await runCompleteIgnoringError(llm);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CircuitBreakerOpenError);
      expect((err as Error).message).toMatch(/400/);
    }
    // fetch must have been called for every attempt — the breaker stayed CLOSED.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(10);
  });
});
