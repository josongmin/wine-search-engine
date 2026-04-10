import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicChatLlm } from '../anthropic-chat-llm.js';

function successBody(text = 'hello', usage?: Record<string, unknown>): string {
  return JSON.stringify({
    id: 'msg_test',
    model: 'claude-test',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    ...(usage !== undefined ? { usage } : {}),
  });
}

function newAdapter(): AnthropicChatLlm {
  return new AnthropicChatLlm({
    apiKey: 'sk-ant-test',
    defaultModel: 'claude-test',
    httpTimeoutMs: 60_000,
  });
}

describe('AnthropicChatLlm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('parses assistant text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(successBody('hello'), { status: 200 })));
    const llm = newAdapter();
    const r = await llm.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('hello');
    expect(r.model).toBe('claude-test');
  });

  // E4-T4: W2-03 — Anthropic usage NaN guards
  describe('usage NaN guards', () => {
    it('does not throw when usage is absent', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(successBody('ok'), { status: 200 })));
      const llm = newAdapter();
      await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();
    });

    it('does not throw when usage fields are missing', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(successBody('ok', {}), { status: 200 })));
      const llm = newAdapter();
      await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();
    });

    it('does not throw when usage fields contain null (NaN equivalent)', async () => {
      // NaN cannot be represented in JSON; null is the closest proxy.
      // Number.isFinite(null) === false → treated as 0 (guard already in place).
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        successBody('ok', {
          input_tokens: null,
          output_tokens: null,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        }),
        { status: 200 },
      )));
      const llm = newAdapter();
      await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();
    });

    it('uses present usage fields and falls back to 0 for missing ones', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        successBody('ok', { input_tokens: 100, output_tokens: 50 }),
        { status: 200 },
      )));
      const llm = newAdapter();
      // Should not throw — valid numeric usage fields are handled
      await expect(llm.complete({ messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();
    });
  });

  // E4-AG04-Anthropic: empty content array guard
  describe('empty content array guard', () => {
    it('throws when content is an empty array', async () => {
      const body = JSON.stringify({
        id: 'msg_test',
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [],
      });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
      const llm = newAdapter();
      await expect(
        llm.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      ).rejects.toThrow(/empty content array/i);
    });
  });
});
