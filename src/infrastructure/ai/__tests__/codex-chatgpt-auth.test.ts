import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasCodexChatGptAuthSync,
  readCodexChatGptAuthSync,
  refreshCodexChatGptAuth,
} from '../codex-chatgpt-auth.js';

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

describe('codex-chatgpt-auth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads a Codex ChatGPT token file from an explicit path', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-codex-auth-'));
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

      const env = { CODEX_AUTH_JSON_PATH: authPath };
      expect(hasCodexChatGptAuthSync(env)).toBe(true);
      expect(readCodexChatGptAuthSync(env)).toEqual({
        path: authPath,
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        accountId: 'acct-1',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refreshes and persists the Codex token bundle', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wine-codex-refresh-'));
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

      const jwt = encodeJwt({ chatgpt_account_id: 'acct-new' });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        id_token: jwt,
      }), { status: 200 }));

      const refreshed = await refreshCodexChatGptAuth(
        {
          path: authPath,
          accessToken: 'at-old',
          refreshToken: 'rt-old',
          accountId: 'acct-old',
        },
        { CODEX_AUTH_JSON_PATH: authPath },
        fetchMock,
      );

      expect(refreshed.accessToken).toBe('at-new');
      expect(refreshed.refreshToken).toBe('rt-new');
      expect(refreshed.accountId).toBe('acct-new');

      const raw = JSON.parse(await readFile(authPath, 'utf8')) as {
        tokens: { access_token: string; refresh_token: string; account_id: string };
      };
      expect(raw.tokens.access_token).toBe('at-new');
      expect(raw.tokens.refresh_token).toBe('rt-new');
      expect(raw.tokens.account_id).toBe('acct-new');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
