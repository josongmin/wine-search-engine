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

    it('rotates to the next pooled key on 429 without waiting for single-key backoff', async () => {
      const seenAuthorizations: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          const authorization = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
          if (authorization !== undefined) seenAuthorizations.push(authorization);
          if (seenAuthorizations.length === 1) {
            return new Response('rate limited', { status: 429 });
          }
          return new Response(successBody('pooled key worked'), { status: 200 });
        }),
      );

      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKeys: ['sk-a', 'sk-b'],
        defaultModel: 'gpt-4o-mini',
        httpTimeoutMs: 5000,
      });

      const result = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });

      expect(result.text).toBe('pooled key worked');
      expect(seenAuthorizations).toEqual(['Bearer sk-a', 'Bearer sk-b']);
    });

    it('respects Retry-After header on 429', async () => {
      vi.useFakeTimers();
      // Pin Math.random to 0 for deterministic timing: jitter = 0, delay = exactly retryAfterMs.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
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

      // Should NOT resolve before 10s (Retry-After header; jitter=0 → exactly 10s)
      await vi.advanceTimersByTimeAsync(9_000);
      // Still waiting — fetch called only once so far
      expect(callCount).toBe(1);

      // Advance past the 10s mark (jitter=0 so exactly 10s is the floor)
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await resultPromise;
      expect(result.text).toBe('ok');
      expect(callCount).toBe(2);
      randomSpy.mockRestore();
    });

    it('uses jittered exponential backoff: 4 attempts complete within the worst-case window', async () => {
      // v4: 429 backoff uses full jitter [0, 2^attempt × base], not fixed exponential.
      // The deterministic timing test (cross the 2s/4s/8s thresholds exactly) was
      // replaced because jitter randomizes timing within the upper bound.
      // We pin jitter to its MAXIMUM by mocking Math.random() to return 1.0,
      // making the test deterministic at the worst-case (maximum) delay.
      vi.useFakeTimers();
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.9999); // jitter near max

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
        httpTimeoutMs: 60_000,
      });

      const resultPromise = llm.complete({ messages: [{ role: 'user', content: 'hi' }] });

      // Attempt 1 fires immediately.
      expect(callCount).toBe(1);

      // Worst-case backoff at attempt 1: ~2s × 0.9999 ≈ 2s. Cross it.
      await vi.advanceTimersByTimeAsync(2_100);
      expect(callCount).toBe(2);

      // Worst-case at attempt 2: ~4s × 0.9999 ≈ 4s.
      await vi.advanceTimersByTimeAsync(4_100);
      expect(callCount).toBe(3);

      // Worst-case at attempt 3: ~8s × 0.9999 ≈ 8s.
      await vi.advanceTimersByTimeAsync(8_100);
      expect(callCount).toBe(4);

      const result = await resultPromise;
      expect(result.text).toBe('ok');
      randomSpy.mockRestore();
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

  // E4-T4: W2-02/W2-03 — LLM usage NaN guards
  describe('usage NaN guards', () => {
    function makeBodyWithUsage(usage: unknown): string {
      return JSON.stringify({
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
        ],
        usage,
      });
    }

    const llm = new OpenAiChatLlm({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      defaultModel: 'gpt-4o-mini',
      httpTimeoutMs: 5000,
    });

    it('does not throw when usage is undefined', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(makeBodyWithUsage(undefined), { status: 200 })));
      await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();
    });

    it('does not throw when usage fields are missing', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(makeBodyWithUsage({}), { status: 200 })));
      await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();
    });

    it('does not throw when usage fields contain NaN', async () => {
      // NaN cannot be serialized as JSON literally — we use null which is parsed as
      // typeof null !== 'number' so Number.isFinite(null) === false → treated as 0
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        makeBodyWithUsage({ prompt_tokens: null, completion_tokens: null }),
        { status: 200 },
      )));
      await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();
    });
  });

  // Reasoning-model parameter routing must agree with the SSoT
  // isReasoningModel() classifier (openai-reasoning-params.ts), not a
  // locally-forked regex. The local /^(?:gpt-5|o\d)/ over-matched o2/o5/o9
  // (the SSoT only recognizes o1/o3/o4 prefixes), splitting the
  // temperature / max_completion_tokens decision from the headroom logic.
  describe('reasoning-model param routing (SSoT parity)', () => {
    async function captureBody(model: string): Promise<Record<string, unknown>> {
      let capturedBody: Record<string, unknown> = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: RequestInit) => {
          const rawBody = init.body;
          if (typeof rawBody !== 'string') {
            throw new Error('expected JSON string request body');
          }
          capturedBody = JSON.parse(rawBody) as Record<string, unknown>;
          return new Response(successBody('ok'), { status: 200 });
        }),
      );
      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        defaultModel: model,
        httpTimeoutMs: 5000,
      });
      await llm.complete({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        maxOutputTokens: 300,
      });
      return capturedBody;
    }

    it('uses max_completion_tokens and omits temperature for gpt-5 reasoning models', async () => {
      const body = await captureBody('gpt-5-mini');
      expect(body['max_completion_tokens']).toBeDefined();
      expect(body['max_tokens']).toBeUndefined();
      expect(body['temperature']).toBeUndefined();
    });

    it('uses max_completion_tokens for o4 reasoning models (SSoT prefix)', async () => {
      const body = await captureBody('o4-mini');
      expect(body['max_completion_tokens']).toBeDefined();
      expect(body['max_tokens']).toBeUndefined();
    });

    it('treats gpt-4o as a non-reasoning model (max_tokens + temperature pass-through)', async () => {
      const body = await captureBody('gpt-4o-mini');
      expect(body['max_tokens']).toBe(300);
      expect(body['max_completion_tokens']).toBeUndefined();
      expect(body['temperature']).toBe(0);
    });

    it('treats o2/o5 as non-reasoning, matching the SSoT (NOT the legacy o\\d regex)', async () => {
      // The SSoT only recognizes o1/o3/o4; the old local regex /^o\d/ wrongly
      // classified o2/o5 as reasoning, setting max_completion_tokens while the
      // headroom helper (also SSoT-gated) treated them as non-reasoning.
      for (const model of ['o2-preview', 'o5-mini']) {
        const body = await captureBody(model);
        expect(body['max_tokens'], `${model} should use max_tokens`).toBe(300);
        expect(body['max_completion_tokens'], `${model} should not use max_completion_tokens`).toBeUndefined();
        expect(body['temperature'], `${model} should pass temperature through`).toBe(0);
      }
    });
  });

  // E4-T8: AG-04 — empty choices array guard
  describe('empty choices guard', () => {
    it('throws when response.choices is empty', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ model: 'gpt-4o-mini', choices: [] }),
        { status: 200 },
      )));
      const llm = new OpenAiChatLlm({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        defaultModel: 'gpt-4o-mini',
        httpTimeoutMs: 5000,
      });
      await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/empty choices/i);
    });
  });
});
