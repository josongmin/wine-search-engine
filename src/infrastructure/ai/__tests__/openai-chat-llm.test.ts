import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiChatLlm } from '../openai-chat-llm.js';

describe('OpenAiChatLlm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses assistant text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            model: 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'hello' },
              },
            ],
          }),
          { status: 200 },
        );
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
});
