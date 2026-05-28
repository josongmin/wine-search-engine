import type { CodexChatGptAuthRecord } from '../../ai/codex-chatgpt-auth.js';

export interface CodexIdentityClaims {
  readonly accountId?: string;
  readonly email?: string;
}

const MIN_JWT_PARTS = 2;
const BASE64_GROUP = 4;

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < MIN_JWT_PARTS) {
    return null;
  }
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) {
    return null;
  }
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padLength = (BASE64_GROUP - (normalized.length % BASE64_GROUP)) % BASE64_GROUP;
    const text = Buffer.from(normalized + '='.repeat(padLength), 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function claimString(payload: Record<string, unknown> | null, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Read-only identity claims for `auth whoami`. Prefers the record's stored
 * `accountId`, falling back to the `chatgpt_account_id` / `email` claims in the
 * id_token. Self-contained so it doesn't depend on the chat adapter's private
 * JWT helpers.
 */
export function decodeCodexIdentity(record: CodexChatGptAuthRecord): CodexIdentityClaims {
  const payload = record.idToken !== undefined ? decodeJwtPayload(record.idToken) : null;
  const accountId = record.accountId ?? claimString(payload, 'chatgpt_account_id');
  const email = claimString(payload, 'email');
  return {
    ...(accountId !== undefined ? { accountId } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}
