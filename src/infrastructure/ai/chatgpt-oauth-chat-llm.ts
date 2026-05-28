import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatLlmPort,
} from '../../domain/ai/port/chat-llm.port.js';
import { isAbortError } from '../http/fetch-with-timeout.js';
import {
  parseRetryAfterHeader,
  retryWithBackoff,
  type RetryConfig,
} from '../http/retry-with-backoff.js';
import {
  CODEX_MODELS_CLIENT_VERSION,
  readCodexChatGptAuth,
  refreshCodexChatGptAuth,
  resolveCodexOAuthConfig,
  type CodexChatGptAuthRecord,
} from './codex-chatgpt-auth.js';

const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';
const RESPONSES_PATH = '/codex/responses';
const MODELS_PATH = '/codex/models';
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1_000;
const MODEL_CATALOG_TTL_MINUTES = 5;
const MODEL_CATALOG_TTL_MS =
  MODEL_CATALOG_TTL_MINUTES * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const PREVIEW_CHARS = 240;
const DATA_PREFIX = 'data:';
const DATA_PREFIX_LENGTH = DATA_PREFIX.length;
const HTTP_STATUS_UNAUTHORIZED = 401;

const CHATGPT_OAUTH_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  transientBackoffBaseMs: 250,
  transientBackoffCapMs: 2_000,
  rateLimitBackoffBaseMs: 2_000,
  rateLimitBackoffCapMs: 30_000,
  label: 'ChatGPT OAuth chat',
};

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ChatGptOAuthChatLlmOptions {
  readonly defaultModel: string;
  readonly httpTimeoutMs: number;
  readonly env?: EnvLike;
  readonly fetchImpl?: FetchLike;
}

interface CatalogEntry {
  readonly model: string;
  readonly isDefault?: boolean;
}

interface CatalogCacheEntry {
  readonly models: readonly CatalogEntry[];
  readonly fetchedAtMs: number;
}

interface StatusError extends Error {
  status: number;
}

function makeStatusError(status: number, message: string): StatusError {
  const error = new Error(message) as StatusError;
  error.status = status;
  return error;
}

function buildResponsesInput(
  messages: readonly { readonly role: string; readonly content: string }[],
): readonly Record<string, unknown>[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      type: 'message',
      role: message.role,
      content: [
        {
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: message.content,
        },
      ],
    }));
}

function buildInstructions(messages: readonly { readonly role: string; readonly content: string }[]): string {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0);
  return instructions.length > 0 ? instructions.join('\n\n') : DEFAULT_INSTRUCTIONS;
}

function parseCatalogEntries(raw: unknown): readonly CatalogEntry[] {
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>)['models'])
      ? (raw as Record<string, unknown>)['models'] as readonly unknown[]
      : typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>)['data'])
        ? (raw as Record<string, unknown>)['data'] as readonly unknown[]
        : [];

  const rows: Array<{ model: string; priority: number; isDefault?: boolean }> = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const row = item as Record<string, unknown>;
    if (typeof row['visibility'] === 'string' && row['visibility'] !== 'list') {
      continue;
    }
    const slug =
      typeof row['slug'] === 'string'
        ? row['slug']
        : typeof row['model'] === 'string'
          ? row['model']
          : typeof row['id'] === 'string'
            ? row['id']
            : null;
    if (slug === null || slug.length === 0) {
      continue;
    }
    rows.push({
      model: slug,
      priority: typeof row['priority'] === 'number' ? row['priority'] : Number.MAX_SAFE_INTEGER,
      ...(row['is_default'] === true ? { isDefault: true } : {}),
    });
  }

  rows.sort((a, b) => a.priority - b.priority);
  return rows.map((row) => row.isDefault === true
    ? { model: row.model, isDefault: true }
    : { model: row.model });
}

async function* parseSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.trim().length > 0) {
          yield frame;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim().length > 0) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseData(frame: string): string | null {
  const chunks: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) {
      continue;
    }
    if (line.startsWith(DATA_PREFIX)) {
      chunks.push(line.slice(DATA_PREFIX_LENGTH).replace(/^ /, ''));
    }
  }
  return chunks.length > 0 ? chunks.join('\n') : null;
}

async function parseResponsesText(response: Response): Promise<{ text: string; model?: string }> {
  if (response.body === null) {
    throw new Error('ChatGPT OAuth chat response has no body');
  }

  let text = '';
  let fallbackText = '';
  let model: string | undefined;

  for await (const frame of parseSseFrames(response.body)) {
    const data = parseSseData(frame);
    if (data === null) {
      continue;
    }
    if (data === '[DONE]') {
      break;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(`ChatGPT OAuth chat SSE parse error: ${data.slice(0, PREVIEW_CHARS)}`);
    }

    if (typeof parsed !== 'object' || parsed === null) {
      continue;
    }

    const event = parsed as Record<string, unknown>;
    const type = typeof event['type'] === 'string' ? event['type'] : undefined;

    if (type === 'response.output_text.delta') {
      const delta = event['delta'];
      if (typeof delta === 'string') {
        text += delta;
      }
      continue;
    }

    if (type === 'response.output_item.done') {
      const item = event['item'];
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        if (record['type'] === 'message' && Array.isArray(record['content'])) {
          const parts = record['content']
            .map((part) =>
              typeof part === 'object'
                && part !== null
                && (part as Record<string, unknown>)['type'] === 'output_text'
                && typeof (part as Record<string, unknown>)['text'] === 'string'
                ? (part as Record<string, unknown>)['text'] as string
                : '',
            )
            .join('');
          fallbackText += parts;
        }
      }
      continue;
    }

    if (type === 'response.completed') {
      const responseMeta = event['response'];
      if (typeof responseMeta === 'object' && responseMeta !== null) {
        const maybeModel = (responseMeta as Record<string, unknown>)['model'];
        if (typeof maybeModel === 'string' && maybeModel.length > 0) {
          model = maybeModel;
        }
      }
      continue;
    }

    if (type === 'response.failed' || type === 'error') {
      throw new Error(`ChatGPT OAuth chat failed: ${data.slice(0, PREVIEW_CHARS)}`);
    }
  }

  const finalText = text.length > 0 ? text : fallbackText;
  if (finalText.length === 0) {
    throw new Error('ChatGPT OAuth chat produced no assistant text');
  }
  return model !== undefined ? { text: finalText, model } : { text: finalText };
}

export class ChatGptOAuthChatLlm implements ChatLlmPort {
  private readonly defaultModel: string;
  private readonly httpTimeoutMs: number;
  private readonly env: EnvLike;
  private readonly fetchImpl: FetchLike;
  private readonly modelCatalogCache = new Map<string, CatalogCacheEntry>();

  constructor(options: ChatGptOAuthChatLlmOptions) {
    this.defaultModel = options.defaultModel;
    this.httpTimeoutMs = options.httpTimeoutMs;
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const record = await readCodexChatGptAuth(this.env, { allowProcessFallback: this.env === process.env });
    if (record === null) {
      throw new Error(
        'ChatGPT OAuth chat is unavailable — sign in with Codex or set OPENAI_API_KEY/OPENAI_API_KEYS.',
      );
    }

    try {
      return await this.completeWithRecord(record, request);
    } catch (error) {
      if ((error as Partial<StatusError>).status !== HTTP_STATUS_UNAUTHORIZED) {
        throw error;
      }
      const refreshed = await refreshCodexChatGptAuth(record, this.env, this.fetchImpl);
      return await this.completeWithRecord(refreshed, request);
    }
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    abortSignal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    if (abortSignal?.aborted === true) {
      controller.abort();
    }

    const id = setTimeout(() => {
      controller.abort();
    }, this.httpTimeoutMs);
    const onAbort = (): void => {
      controller.abort();
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(id);
      abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  private async completeWithRecord(
    record: CodexChatGptAuthRecord,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> {
    const wantedModel = request.model ?? this.defaultModel;
    const model = await this.resolveModel(record, wantedModel);
    const config = resolveCodexOAuthConfig(this.env);
    const url = `${config.apiBase}${RESPONSES_PATH}`;

    const inputItems = buildResponsesInput(request.messages);
    const body: Record<string, unknown> = {
      model,
      instructions: buildInstructions(request.messages),
      input: inputItems,
      stream: true,
      store: false,
      // The ChatGPT-account `/codex/responses` surface is not a drop-in
      // chat-completions clone. Keep the payload on the proven subset only.
    };

    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      authorization: `Bearer ${record.accessToken}`,
      'content-type': 'application/json',
      'oai-product-sku': config.sku,
      originator: config.originator,
    };
    if (record.accountId !== undefined) {
      headers['chatgpt-account-id'] = record.accountId;
    }

    const response = await retryWithBackoff(
      async () => {
        let httpResponse: Response;
        try {
          httpResponse = await this.fetchWithTimeout(
            url,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(body),
            },
            request.abortSignal,
          );
        } catch (error) {
          if (isAbortError(error)) {
            const abortError = new Error(`ChatGPT OAuth chat: request timed out after ${this.httpTimeoutMs}ms`);
            abortError.name = 'AbortError';
            throw abortError;
          }
          throw error;
        }

        if (httpResponse.status === HTTP_STATUS_UNAUTHORIZED) {
          throw makeStatusError(
            HTTP_STATUS_UNAUTHORIZED,
            'ChatGPT OAuth chat token rejected (401)',
          );
        }
        if (!httpResponse.ok) {
          return {
            kind: 'http-error' as const,
            status: httpResponse.status,
            bodyText: await httpResponse.text().catch(() => ''),
            retryAfterSec: parseRetryAfterHeader(httpResponse),
          };
        }

        return { kind: 'success' as const, value: httpResponse };
      },
      CHATGPT_OAUTH_RETRY_CONFIG,
      request.abortSignal,
    );

    const parsed = await parseResponsesText(response);
    return {
      text: parsed.text,
      model: parsed.model ?? model,
      finishReason: 'stop',
    };
  }

  private async resolveModel(
    record: CodexChatGptAuthRecord,
    wantedModel: string,
  ): Promise<string> {
    const cacheKey = record.accountId ?? 'default';
    const now = Date.now();
    const cached = this.modelCatalogCache.get(cacheKey);
    if (cached !== undefined && now - cached.fetchedAtMs < MODEL_CATALOG_TTL_MS) {
      return this.pickModel(cached.models, wantedModel);
    }

    const models = await this.fetchModelCatalog(record);
    this.modelCatalogCache.set(cacheKey, { models, fetchedAtMs: now });
    return this.pickModel(models, wantedModel);
  }

  private pickModel(models: readonly CatalogEntry[], wantedModel: string): string {
    if (models.some((entry) => entry.model === wantedModel)) {
      return wantedModel;
    }
    const fallback = models.find((entry) => entry.isDefault === true)?.model ?? models[0]?.model;
    if (fallback === undefined) {
      throw new Error(`ChatGPT OAuth chat has no available model for requested "${wantedModel}"`);
    }
    return fallback;
  }

  private async fetchModelCatalog(record: CodexChatGptAuthRecord): Promise<readonly CatalogEntry[]> {
    const config = resolveCodexOAuthConfig(this.env);
    const url = `${config.apiBase}${MODELS_PATH}?client_version=${encodeURIComponent(CODEX_MODELS_CLIENT_VERSION)}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${record.accessToken}`,
      'oai-product-sku': config.sku,
      originator: config.originator,
    };
    if (record.accountId !== undefined) {
      headers['chatgpt-account-id'] = record.accountId;
    }

    let response: Response;
    try {
      response = await this.fetchWithTimeout(url, { method: 'GET', headers }, undefined);
    } catch (error) {
      if (isAbortError(error)) {
        const abortError = new Error(`ChatGPT OAuth model catalog: request timed out after ${this.httpTimeoutMs}ms`);
        abortError.name = 'AbortError';
        throw abortError;
      }
      throw error;
    }
    if (response.status === HTTP_STATUS_UNAUTHORIZED) {
      throw makeStatusError(
        HTTP_STATUS_UNAUTHORIZED,
        'ChatGPT OAuth model catalog rejected token (401)',
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`ChatGPT OAuth model catalog failed [HTTP ${response.status}]: ${text.slice(0, PREVIEW_CHARS)}`);
    }

    const parsed = await response.json().catch(() => null);
    const models = parseCatalogEntries(parsed);
    if (models.length === 0) {
      throw new Error('ChatGPT OAuth model catalog is empty');
    }
    return models;
  }
}
