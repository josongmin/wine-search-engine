import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatGptOAuthChatLlm } from '../chatgpt-oauth-chat-llm.js';

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

function makeStreamResponse(events: readonly string[]): Response {
  return new Response(`${events.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toUrlString(input: string | URL | Request): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
}

describe('ChatGptOAuthChatLlm', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('streams assistant text using the Codex auth token', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-codex-chat-'));
    const authPath = path.join(dir, 'auth.json');
    try {
      await writeFile(authPath, JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          account_id: 'acct-1',
        },
      }), 'utf8');

      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);
        if (url.includes('/codex/models')) {
          expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer at-1');
          return new Response(JSON.stringify({
            models: [{ slug: 'gpt-5.4-mini', visibility: 'list', priority: 1 }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
        const headers = init?.headers as Record<string, string>;
        expect(headers['authorization'] ?? headers['Authorization']).toBe('Bearer at-1');
        expect(headers['chatgpt-account-id']).toBe('acct-1');
        return makeStreamResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}',
          'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.4-mini"}}',
          'data: [DONE]',
        ]);
      });
      vi.stubGlobal('fetch', fetchMock);

      const llm = new ChatGptOAuthChatLlm({
        env: { CODEX_AUTH_JSON_PATH: authPath },
        defaultModel: 'gpt-5.4-mini',
        httpTimeoutMs: 5_000,
      });

      const result = await llm.complete({
        messages: [{ role: 'user', content: 'hello?' }],
      });

      expect(result.text).toBe('hello');
      expect(result.model).toBe('gpt-5.4-mini');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refreshes the token once after a 401 and retries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-codex-refresh-chat-'));
    const authPath = path.join(dir, 'auth.json');
    try {
      await writeFile(authPath, JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: 'at-old',
          refresh_token: 'rt-old',
          account_id: 'acct-old',
        },
      }), 'utf8');

      let responseAttempt = 0;
      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);
        if (url.includes('/codex/models')) {
          return new Response(JSON.stringify({
            models: [{ slug: 'gpt-5.4-mini', visibility: 'list', priority: 1 }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/oauth/token')) {
          return new Response(JSON.stringify({
            access_token: 'at-new',
            refresh_token: 'rt-new',
            id_token: encodeJwt({ chatgpt_account_id: 'acct-new' }),
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        responseAttempt += 1;
        const headers = init?.headers as Record<string, string>;
        const authHeader = headers['authorization'] ?? headers['Authorization'];
        if (responseAttempt === 1) {
          expect(authHeader).toBe('Bearer at-old');
          return new Response('unauthorized', { status: 401 });
        }
        expect(authHeader).toBe('Bearer at-new');
        expect(headers['chatgpt-account-id']).toBe('acct-new');
        return makeStreamResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}',
          'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.4-mini"}}',
          'data: [DONE]',
        ]);
      });
      vi.stubGlobal('fetch', fetchMock);

      const llm = new ChatGptOAuthChatLlm({
        env: { CODEX_AUTH_JSON_PATH: authPath },
        defaultModel: 'gpt-5.4-mini',
        httpTimeoutMs: 5_000,
      });

      const result = await llm.complete({
        messages: [{ role: 'user', content: 'hello?' }],
      });

      expect(result.text).toBe('ok');
      const persisted = JSON.parse(await readFile(authPath, 'utf8')) as {
        tokens: { access_token: string; refresh_token: string; account_id: string };
      };
      expect(persisted.tokens.access_token).toBe('at-new');
      expect(persisted.tokens.refresh_token).toBe('rt-new');
      expect(persisted.tokens.account_id).toBe('acct-new');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses the injected fetch implementation and omits unsupported chat-completions params', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-codex-chat-fetchimpl-'));
    const authPath = path.join(dir, 'auth.json');
    try {
      await writeFile(authPath, JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: 'at-1',
          refresh_token: 'rt-1',
          account_id: 'acct-1',
        },
      }), 'utf8');

      const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = toUrlString(input);
        if (url.includes('/codex/models')) {
          return new Response(JSON.stringify({
            models: [{ slug: 'gpt-5.4-mini', visibility: 'list', priority: 1 }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
        if (typeof init?.body !== 'string') {
          throw new Error('Expected string request body');
        }
        const body = JSON.parse(init.body) as Record<string, unknown>;
        expect(body).not.toHaveProperty('max_output_tokens');
        expect(body).not.toHaveProperty('seed');
        expect(body).not.toHaveProperty('temperature');
        return makeStreamResponse([
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}',
          'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.4-mini"}}',
          'data: [DONE]',
        ]);
      });

      const llm = new ChatGptOAuthChatLlm({
        env: { CODEX_AUTH_JSON_PATH: authPath },
        defaultModel: 'gpt-5.4-mini',
        httpTimeoutMs: 5_000,
        fetchImpl: fetchMock,
      });

      const result = await llm.complete({
        messages: [{ role: 'user', content: 'hello?' }],
        temperature: 0,
        seed: 123,
        maxOutputTokens: 17,
      });

      expect(result.text).toBe('ok');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
