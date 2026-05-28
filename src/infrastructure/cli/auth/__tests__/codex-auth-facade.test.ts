import { describe, expect, it } from 'vitest';
import { CodexAuthFacade } from '../codex-auth-facade.js';
import { CodexLoginDelegateAdapter } from '../codex-login-delegate.js';
import type {
  CodexAuthRecordStore,
  CodexModelCatalogProbe,
} from '../codex-auth-ports.js';
import type { CodexChatGptAuthRecord } from '../../../ai/codex-chatgpt-auth.js';
import type { CodexIdentityClaims } from '../decode-codex-identity.js';
import { CliError } from '../../../../application/cli/command/cli-error.js';

const fullRecord: CodexChatGptAuthRecord = {
  path: '/tmp/auth.json',
  accessToken: 'tok',
  refreshToken: 'ref',
  idToken: 'id',
  accountId: 'acc-1',
};

function fakeStore(overrides: Partial<CodexAuthRecordStore> = {}): CodexAuthRecordStore {
  return {
    authPath: () => '/tmp/auth.json',
    authFileExists: () => true,
    read: async () => fullRecord,
    refresh: async (record) => record,
    identity: (): CodexIdentityClaims => ({ accountId: 'acc-1', email: 'a@b.com' }),
    ...overrides,
  };
}

const okProbe: CodexModelCatalogProbe = {
  probe: async () => ({ ok: true, status: 200, modelCount: 5 }),
};
const login = new CodexLoginDelegateAdapter();

function facade(
  storeOverrides: Partial<CodexAuthRecordStore> = {},
  probe: CodexModelCatalogProbe = okProbe,
): CodexAuthFacade {
  return new CodexAuthFacade(fakeStore(storeOverrides), probe, login);
}

describe('CodexAuthFacade', () => {
  it('status: authenticated when a record is present', async () => {
    const result = await facade().status();
    expect(result.authenticated).toBe(true);
    expect(result.authMode).toBe('chatgpt');
    expect(result.hasRefreshToken).toBe(true);
    expect(result.accountId).toBe('acc-1');
  });

  it('status: unauthenticated when no record', async () => {
    const result = await facade({ read: async () => null, authFileExists: () => false }).status();
    expect(result.authenticated).toBe(false);
    expect(result.authMode).toBeNull();
    expect(result.hasAccessToken).toBe(false);
  });

  it('path: reports existence', async () => {
    expect(await facade().path()).toEqual({ path: '/tmp/auth.json', exists: true });
  });

  it('refresh: throws CliError(auth) when no record', async () => {
    await expect(facade({ read: async () => null }).refresh()).rejects.toBeInstanceOf(CliError);
  });

  it('refresh: throws CliError(auth) when no refresh token', async () => {
    const noRefresh: CodexChatGptAuthRecord = { path: '/tmp/auth.json', accessToken: 'tok' };
    await expect(facade({ read: async () => noRefresh }).refresh()).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it('refresh: succeeds and returns account id', async () => {
    const result = await facade().refresh();
    expect(result.refreshed).toBe(true);
    expect(result.accountId).toBe('acc-1');
  });

  it('doctor: healthy when token valid and probe ok', async () => {
    const result = await facade().doctor({ target: 'local', authMode: 'codex' });
    expect(result.healthy).toBe(true);
    expect(result.checks.find((c) => c.name === 'model_catalog_probe')?.status).toBe('ok');
  });

  it('doctor: unhealthy and probe skipped when no record', async () => {
    const result = await facade({ read: async () => null, authFileExists: () => false }).doctor({
      target: 'local',
      authMode: 'codex',
    });
    expect(result.healthy).toBe(false);
    expect(result.checks.find((c) => c.name === 'model_catalog_probe')?.detail).toContain('skipped');
  });

  it('doctor: probe failure marks unhealthy', async () => {
    const badProbe: CodexModelCatalogProbe = {
      probe: async () => ({ ok: false, status: 401, modelCount: 0 }),
    };
    const result = await facade({}, badProbe).doctor({ target: 'local', authMode: 'codex' });
    expect(result.healthy).toBe(false);
  });

  it('doctor: remote target requires a base URL', async () => {
    const result = await facade().doctor({ target: 'remote', authMode: 'codex' });
    expect(result.checks.find((c) => c.name === 'remote_base_url')?.status).toBe('fail');
    expect(result.healthy).toBe(false);
  });

  it('whoami: returns identity claims', async () => {
    const result = await facade().whoami();
    expect(result).toMatchObject({ authenticated: true, accountId: 'acc-1', email: 'a@b.com' });
  });

  it('login: delegates to Codex without owning OAuth', async () => {
    const result = await facade().login();
    expect(result.delegated).toBe(false);
    expect(result.delegateCommand).toBe('codex login');
    expect(result.alreadyAuthenticated).toBe(true);
  });
});
