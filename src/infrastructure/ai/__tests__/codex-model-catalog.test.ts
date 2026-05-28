import { describe, expect, it } from 'vitest';
import {
  CODEX_MODELS_PATH,
  buildCodexModelsHeaders,
  buildCodexModelsUrl,
  probeCodexModelCatalog,
} from '../codex-model-catalog.js';
import type { CodexChatGptAuthRecord } from '../codex-chatgpt-auth.js';

const record: CodexChatGptAuthRecord = {
  path: '/tmp/auth.json',
  accessToken: 'tok',
  accountId: 'acc-1',
};

describe('codex model catalog probe (SSoT)', () => {
  it('builds the models URL from the shared path constant', () => {
    expect(buildCodexModelsUrl({})).toContain(CODEX_MODELS_PATH);
  });

  it('builds auth headers including account id', () => {
    const headers = buildCodexModelsHeaders(record, {});
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['chatgpt-account-id']).toBe('acc-1');
  });

  it('reports ok with model count on 200', async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(JSON.stringify({ models: [{}, {}, {}] }), { status: 200 });
    const result = await probeCodexModelCatalog(record, { fetchImpl, env: {} });
    expect(result).toEqual({ ok: true, status: 200, modelCount: 3 });
  });

  it('reports not-ok with status on a non-2xx response', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('nope', { status: 401 });
    const result = await probeCodexModelCatalog(record, { fetchImpl, env: {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('captures transport errors without throwing', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('network down');
    };
    const result = await probeCodexModelCatalog(record, { fetchImpl, env: {} });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain('network down');
  });
});
