import { describe, expect, it } from 'vitest';
import { decodeCodexIdentity } from '../decode-codex-identity.js';
import type { CodexChatGptAuthRecord } from '../../../ai/codex-chatgpt-auth.js';

function makeIdToken(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `header.${payload}.signature`;
}

function record(overrides: Partial<CodexChatGptAuthRecord> = {}): CodexChatGptAuthRecord {
  return { path: '/tmp/auth.json', accessToken: 'tok', ...overrides };
}

describe('decodeCodexIdentity', () => {
  it('extracts accountId and email from the id_token', () => {
    const claims = decodeCodexIdentity(
      record({ idToken: makeIdToken({ chatgpt_account_id: 'acc-9', email: 'x@y.z' }) }),
    );
    expect(claims).toEqual({ accountId: 'acc-9', email: 'x@y.z' });
  });

  it('prefers the stored record accountId over the token claim', () => {
    const claims = decodeCodexIdentity(
      record({ accountId: 'rec-acc', idToken: makeIdToken({ chatgpt_account_id: 'tok-acc' }) }),
    );
    expect(claims.accountId).toBe('rec-acc');
  });

  it('returns empty claims for a malformed token', () => {
    expect(decodeCodexIdentity(record({ idToken: 'not-a-jwt' }))).toEqual({});
  });

  it('returns empty claims when no id_token is present', () => {
    expect(decodeCodexIdentity(record())).toEqual({});
  });
});
