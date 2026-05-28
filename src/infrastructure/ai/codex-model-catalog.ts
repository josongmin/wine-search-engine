import {
  CODEX_MODELS_CLIENT_VERSION,
  resolveCodexOAuthConfig,
  type CodexChatGptAuthRecord,
} from './codex-chatgpt-auth.js';

/**
 * Canonical home for the Codex `/codex/models` endpoint + a read-only health
 * probe used by the CLI auth doctor. The production chat adapter
 * (chatgpt-oauth-chat-llm.ts) still keeps a private copy of this path; that
 * file should migrate to this constant when it is next refactored/lint-cleaned
 * (it carries unrelated pre-existing lint debt today). New code MUST import
 * from here (CLAUDE.md SSoT rule 30).
 */
export const CODEX_MODELS_PATH = '/codex/models';

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface CodexModelCatalogProbeOptions {
  readonly env?: EnvLike;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export interface CodexModelCatalogProbeResult {
  readonly ok: boolean;
  /** HTTP status, or `0` when the request never completed (network/timeout). */
  readonly status: number;
  readonly modelCount: number;
  readonly error?: string;
}

export function buildCodexModelsUrl(env: EnvLike = process.env): string {
  const config = resolveCodexOAuthConfig(env);
  return `${config.apiBase}${CODEX_MODELS_PATH}?client_version=${encodeURIComponent(
    CODEX_MODELS_CLIENT_VERSION,
  )}`;
}

export function buildCodexModelsHeaders(
  record: CodexChatGptAuthRecord,
  env: EnvLike = process.env,
): Record<string, string> {
  const config = resolveCodexOAuthConfig(env);
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${record.accessToken}`,
    'oai-product-sku': config.sku,
    originator: config.originator,
  };
  if (record.accountId !== undefined) {
    headers['chatgpt-account-id'] = record.accountId;
  }
  return headers;
}

function countCatalogModels(raw: unknown): number {
  if (Array.isArray(raw)) {
    return raw.length;
  }
  if (typeof raw === 'object' && raw !== null) {
    const obj: Record<string, unknown> = raw as Record<string, unknown>;
    const models = obj['models'];
    if (Array.isArray(models)) {
      return models.length;
    }
    const data = obj['data'];
    if (Array.isArray(data)) {
      return data.length;
    }
  }
  return 0;
}

/**
 * Read-only health probe of the Codex model catalog with the current token.
 * Never throws: transport failures and non-2xx responses are reported via the
 * result so callers (notably `auth doctor`) can render a deterministic check.
 */
export async function probeCodexModelCatalog(
  record: CodexChatGptAuthRecord,
  options: CodexModelCatalogProbeOptions = {},
): Promise<CodexModelCatalogProbeResult> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(buildCodexModelsUrl(env), {
      method: 'GET',
      headers: buildCodexModelsHeaders(record, env),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      modelCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return { ok: false, status: response.status, modelCount: 0 };
  }

  const parsed: unknown = await response.json().catch(() => null);
  return { ok: true, status: response.status, modelCount: countCatalogModels(parsed) };
}
