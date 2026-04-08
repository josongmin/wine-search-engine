import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiChatLlm } from '../openai-chat-llm.js';

/** Helper: build a minimal successful OpenAI response body. */
function successBody(content = 'hello'): string {
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

describe('OpenAiChatLlm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('parses assistant text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(successBody('hello'), { status: 200 });
      }),
    );

    const llm = new OpenAiChatLlm({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o-mini',
      httpTimeoutMs: 5000,
    });

    const r = await llm.complete({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.text).toBe('hello');
    expect(r.model).toBe('gpt-4o-mini');
    expect(r.finishReason).toBe('stop');

    expect(fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  describe('429 rate-limit handling', () => {
    it('retries on 429 and succeeds on next attempt', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return new Response('rate limited', {
              status: 429,
              headers: { 'Content-Type': 'text/plain' },
            });
          }
          return new Response(successBody('retry worked'), { status: 200 });
        }),
      );

      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        defaultModel: 'gpt-4o-mini',
        httpTimeoutMs: 5000,
      });

      const resultPromise = llm.complete({ messages: [{ role: 'user', content: 'hi' }] });

      // Advance past the 2s base rate-limit delay
      await vi.advanceTimersByTimeAsync(2_001);

      const result = await resultPromise;
      expect(result.text).toBe('retry worked');
      expect(callCount).toBe(2);
    });

    it('respects Retry-After header on 429', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return new Response('rate limited', {
              status: 429,
              headers: { 'Retry-After': '10', 'Content-Type': 'text/plain' },
            });
          }
          return new Response(successBody('ok'), { status: 200 });
        }),
      );

      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        defaultModel: 'gpt-4o-mini',
        httpTimeoutMs: 5000,
      });

      const resultPromise = llm.complete({ messages: [{ role: 'user', content: 'hi' }] });

      // Should NOT resolve before 10s (Retry-After header)
      await vi.advanceTimersByTimeAsync(9_000);
      // Still waiting — fetch called only once so far
      expect(callCount).toBe(1);

      // Advance past the 10s mark
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await resultPromise;
      expect(result.text).toBe('ok');
      expect(callCount).toBe(2);
    });

    it('uses exponential backoff: makes exactly 4 attempts across the 2s+4s+8s window', async () => {
      vi.useFakeTimers();
      let callCount = 0;

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          callCount++;
          if (callCount < 4) {
            return new Response('rate limited', { status: 429 });
          }
          return new Response(successBody('ok'), { status: 200 });
        }),
      );

      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        defaultModel: 'gpt-4o-mini',
        // Use a large httpTimeoutMs (60s) so fetchWithTimeout's internal timer
        // does not interfere with the rate-limit sleep timers.
        httpTimeoutMs: 60_000,
      });

      const resultPromise = llm.complete({ messages: [{ role: 'user', content: 'hi' }] });

      // Attempt 1 fires immediately.
      expect(callCount).toBe(1);

      // Not enough time for attempt 2 (needs 2s).
      await vi.advanceTimersByTimeAsync(1_500);
      expect(callCount).toBe(1);

      // Cross the 2s threshold → attempt 2.
      await vi.advanceTimersByTimeAsync(600);
      expect(callCount).toBe(2);

      // Not enough time for attempt 3 (needs another 4s from attempt 2).
      await vi.advanceTimersByTimeAsync(3_500);
      expect(callCount).toBe(2);

      // Cross the 4s threshold → attempt 3.
      await vi.advanceTimersByTimeAsync(600);
      expect(callCount).toBe(3);

      // Not enough time for attempt 4 (needs another 8s from attempt 3).
      await vi.advanceTimersByTimeAsync(7_500);
      expect(callCount).toBe(3);

      // Cross the 8s threshold → attempt 4 (success).
      await vi.advanceTimersByTimeAsync(600);
      expect(callCount).toBe(4);

      const result = await resultPromise;
      expect(result.text).toBe('ok');
    });

    it('throws after exhausting all retries on persistent 429', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          return new Response('rate limited', { status: 429 });
        }),
      );

      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        defaultModel: 'gpt-4o-mini',
        // Large httpTimeoutMs to avoid interference with rate-limit sleep timers.
        httpTimeoutMs: 60_000,
      });

      // Wrap in a rejection-capturing promise before advancing timers.
      // Fake timers cause the rejection to land during advanceTimersByTimeAsync,
      // before the `rejects.toThrow` handler is attached — that triggers an
      // unhandled-rejection warning. Catching into a variable avoids it.
      let caughtError: unknown;
      const resultPromise = llm
        .complete({ messages: [{ role: 'user', content: 'hi' }] })
        .catch((err: unknown) => { caughtError = err; });

      // Advance enough for all 3 retries (MAX_ATTEMPTS=4) to exhaust: 2s + 4s + 8s + buffer
      await vi.advanceTimersByTimeAsync(20_000);
      await resultPromise;

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toMatch(/429/i);
    });

    it('does NOT use slow backoff for 5xx errors', async () => {
      vi.useFakeTimers();
      let callCount = 0;

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          callCount++;
          if (callCount === 1) {
            return new Response('server error', { status: 503 });
          }
          return new Response(successBody('ok'), { status: 200 });
        }),
      );

      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        defaultModel: 'gpt-4o-mini',
        // Large httpTimeoutMs to avoid interference with backoff sleep timers.
        httpTimeoutMs: 60_000,
      });

      const resultPromise = llm.complete({ messages: [{ role: 'user', content: 'hi' }] });

      // 5xx uses fast jittered backoff (max 2s), so it must fire well within 2s.
      // Advance 2s — if fast backoff is used, the second attempt fires before this.
      await vi.advanceTimersByTimeAsync(2_000);
      // Second fetch should have been made
      expect(callCount).toBe(2);

      const result = await resultPromise;
      expect(result.text).toBe('ok');
    });

    it('aborts mid-wait when signal fires', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          return new Response('rate limited', { status: 429 });
        }),
      );

      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        defaultModel: 'gpt-4o-mini',
        httpTimeoutMs: 5000,
      });

      const controller = new AbortController();
      const resultPromise = llm.complete({
        messages: [{ role: 'user', content: 'hi' }],
        abortSignal: controller.signal,
      });

      // Advance just past first fetch; now sleeping for 2s rate-limit wait
      await vi.advanceTimersByTimeAsync(500);
      controller.abort();

      await expect(resultPromise).rejects.toThrow(/abort/i);
    });
  });
});
