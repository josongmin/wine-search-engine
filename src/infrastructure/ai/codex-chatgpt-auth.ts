import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

export const DEFAULT_CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
export const DEFAULT_CODEX_CHATGPT_API_BASE = 'https://chatgpt.com/backend-api';
export const DEFAULT_CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const DEFAULT_CODEX_OAUTH_SKU = 'CODEX';
export const DEFAULT_CODEX_OAUTH_ORIGINATOR = 'codex_cli';
export const CODEX_MODELS_CLIENT_VERSION = '0.0.1';
const CODEX_DEFAULT_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

/** Base64 encodes 4 chars per group; used to compute `=` padding length. */
const BASE64_GROUP_SIZE = 4;
/** Truncate attacker-influenced error bodies in thrown messages. */
const ERROR_BODY_PREVIEW_CHARS = 200;

/** Trim an env value, falling back to a default when absent or blank. */
function trimmedEnvOrDefault(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : fallback;
}

export interface CodexOAuthConfig {
  readonly issuer: string;
  readonly apiBase: string;
  readonly clientId: string;
  readonly sku: string;
  readonly originator: string;
}

export interface CodexChatGptAuthRecord {
  readonly path: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly accountId?: string;
}

export interface CodexAuthReadOptions {
  readonly allowProcessFallback?: boolean;
}

interface RawAuthFile {
  readonly auth_mode?: unknown;
  readonly tokens?: unknown;
}

interface RawTokenFile {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly id_token?: unknown;
  readonly account_id?: unknown;
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function resolveExplicitAuthPath(env: EnvLike): string | undefined {
  const value = env['CODEX_AUTH_JSON_PATH']?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function resolveCodexAuthPath(env: EnvLike = process.env): string {
  return resolveExplicitAuthPath(env) ?? path.join(os.homedir(), '.codex', 'auth.json');
}

function shouldReadCodexAuth(env: EnvLike, options?: CodexAuthReadOptions): boolean {
  if (resolveExplicitAuthPath(env) !== undefined) {
    return true;
  }
  return options?.allowProcessFallback ?? false;
}

function parseCodexAuthJson(raw: string, authPath: string): CodexChatGptAuthRecord | null {
  let parsedUnknown: unknown;
  try {
    // CLAUDE.md rule 12: cast to `unknown` first, then validate shape.
    parsedUnknown = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsedUnknown !== 'object' || parsedUnknown === null) {
    return null;
  }
  const parsed = parsedUnknown as RawAuthFile;

  if (parsed.auth_mode !== 'chatgpt') {
    return null;
  }

  const tokensUnknown = parsed.tokens;
  if (typeof tokensUnknown !== 'object' || tokensUnknown === null) {
    return null;
  }
  const tokens = tokensUnknown as RawTokenFile;

  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    return null;
  }

  return {
    path: authPath,
    accessToken: tokens.access_token,
    ...(typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
      ? { refreshToken: tokens.refresh_token }
      : {}),
    ...(typeof tokens.id_token === 'string' && tokens.id_token.length > 0
      ? { idToken: tokens.id_token }
      : {}),
    ...(typeof tokens.account_id === 'string' && tokens.account_id.length > 0
      ? { accountId: tokens.account_id }
      : {}),
  };
}

export function readCodexChatGptAuthSync(
  env: EnvLike = process.env,
  options?: CodexAuthReadOptions,
): CodexChatGptAuthRecord | null {
  if (!shouldReadCodexAuth(env, options)) {
    return null;
  }

  const authPath = resolveCodexAuthPath(env);
  if (!existsSync(authPath)) {
    return null;
  }

  try {
    return parseCodexAuthJson(readFileSync(authPath, 'utf8'), authPath);
  } catch {
    return null;
  }
}

export async function readCodexChatGptAuth(
  env: EnvLike = process.env,
  options?: CodexAuthReadOptions,
): Promise<CodexChatGptAuthRecord | null> {
  if (!shouldReadCodexAuth(env, options)) {
    return null;
  }

  const authPath = resolveCodexAuthPath(env);
  try {
    return parseCodexAuthJson(await readFile(authPath, 'utf8'), authPath);
  } catch {
    return null;
  }
}

export function hasCodexChatGptAuthSync(
  env: EnvLike = process.env,
  options?: CodexAuthReadOptions,
): boolean {
  return readCodexChatGptAuthSync(env, options) !== null;
}

export function resolveCodexOAuthConfig(env: EnvLike = process.env): CodexOAuthConfig {
  return {
    issuer: trimmedEnvOrDefault(env['CODEX_OAUTH_ISSUER'], DEFAULT_CODEX_OAUTH_ISSUER),
    apiBase: trimmedEnvOrDefault(env['CODEX_CHATGPT_API_BASE'], DEFAULT_CODEX_CHATGPT_API_BASE),
    clientId: trimmedEnvOrDefault(env['CODEX_OAUTH_CLIENT_ID'], DEFAULT_CODEX_OAUTH_CLIENT_ID),
    sku: trimmedEnvOrDefault(env['CODEX_OAUTH_SKU'], DEFAULT_CODEX_OAUTH_SKU),
    originator: trimmedEnvOrDefault(env['CODEX_OAUTH_ORIGINATOR'], DEFAULT_CODEX_OAUTH_ORIGINATOR),
  };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) {
    return null;
  }
  const payload = parts[1];
  if (payload === undefined || payload.length === 0) {
    return null;
  }
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((BASE64_GROUP_SIZE - normalized.length % BASE64_GROUP_SIZE) % BASE64_GROUP_SIZE);
    const text = Buffer.from(padded, 'base64').toString('utf8');
    // CLAUDE.md rule 12: cast to `unknown` first, then validate shape.
    // The JWT payload is attacker-influenced (encoded by the IdP); a
    // primitive (string/number) or array would otherwise be coerced
    // into a Record<> and crash downstream property reads.
    const candidate: unknown = JSON.parse(text);
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      return null;
    }
    return candidate as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractAccountId(idToken: string | undefined): string | undefined {
  if (idToken === undefined) {
    return undefined;
  }
  const payload = decodeJwtPayload(idToken);
  const accountId = payload?.['chatgpt_account_id'];
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

export async function writeCodexChatGptAuth(
  record: CodexChatGptAuthRecord,
): Promise<void> {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await readFile(record.path, 'utf8');
    const candidate = JSON.parse(raw) as unknown;
    if (typeof candidate === 'object' && candidate !== null) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const existingTokens =
    typeof parsed['tokens'] === 'object' && parsed['tokens'] !== null
      ? parsed['tokens'] as Record<string, unknown>
      : {};

  parsed['auth_mode'] = 'chatgpt';
  parsed['tokens'] = {
    ...existingTokens,
    access_token: record.accessToken,
    ...(record.refreshToken !== undefined ? { refresh_token: record.refreshToken } : {}),
    ...(record.idToken !== undefined ? { id_token: record.idToken } : {}),
    ...(record.accountId !== undefined ? { account_id: record.accountId } : {}),
  };
  parsed['last_refresh'] = new Date().toISOString();

  await writeFile(record.path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

export async function refreshCodexChatGptAuth(
  record: CodexChatGptAuthRecord,
  env: EnvLike = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<CodexChatGptAuthRecord> {
  if (record.refreshToken === undefined || record.refreshToken.length === 0) {
    throw new Error('Codex ChatGPT auth record has no refresh token');
  }

  const config = resolveCodexOAuthConfig(env);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: record.refreshToken,
    scope: CODEX_DEFAULT_SCOPE,
  });

  const response = await fetchImpl(`${config.issuer}/oauth/token`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.length > 0) {
    let candidate: unknown;
    try {
      // CLAUDE.md rule 12: cast to `unknown` first; the OAuth server
      // could return a primitive or an array on misconfiguration.
      candidate = JSON.parse(text);
    } catch {
      if (!response.ok) {
        throw new Error(`Codex auth refresh failed: HTTP ${response.status} ${text.slice(0, ERROR_BODY_PREVIEW_CHARS)}`);
      }
      throw new Error('Codex auth refresh returned malformed JSON');
    }
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      if (!response.ok) {
        throw new Error(`Codex auth refresh failed: HTTP ${response.status} ${text.slice(0, ERROR_BODY_PREVIEW_CHARS)}`);
      }
      throw new Error('Codex auth refresh returned a non-object JSON body');
    }
    parsed = candidate as Record<string, unknown>;
  }

  if (!response.ok) {
    const errorCode = typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown';
    const description = typeof parsed['error_description'] === 'string'
      ? parsed['error_description']
      : text.slice(0, ERROR_BODY_PREVIEW_CHARS);
    throw new Error(`Codex auth refresh failed: HTTP ${response.status} ${errorCode}: ${description}`);
  }

  const accessToken = parsed['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('Codex auth refresh response missing access_token');
  }

  const idToken = typeof parsed['id_token'] === 'string' && parsed['id_token'].length > 0
    ? parsed['id_token']
    : record.idToken;
  const refreshed: CodexChatGptAuthRecord = {
    path: record.path,
    accessToken,
    refreshToken:
      typeof parsed['refresh_token'] === 'string' && parsed['refresh_token'].length > 0
        ? parsed['refresh_token']
        : record.refreshToken,
    ...(idToken !== undefined ? { idToken } : {}),
    ...(extractAccountId(idToken) ?? record.accountId
      ? { accountId: extractAccountId(idToken) ?? record.accountId }
      : {}),
  };

  await writeCodexChatGptAuth(refreshed);
  return refreshed;
}
